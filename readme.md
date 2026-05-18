# rajcv-infra

> A production-grade, self-hosted personal platform built for learning and real-world use. Zero open inbound ports. Full observability. Event-driven architecture. Runs entirely on a single machine behind Cloudflare.

---

## Table of Contents

- [What This Is](#what-this-is)
- [Architecture Overview](#architecture-overview)
- [Services Breakdown](#services-breakdown)
- [Networking Design](#networking-design)
- [Observability Stack](#observability-stack)
- [Security Decisions](#security-decisions)
- [Trade-offs & Design Decisions](#trade-offs--design-decisions)
- [Known Limitations & What I'd Change at Scale](#known-limitations--what-id-change-at-scale)
- [Running Locally](#running-locally)
- [Environment Variables](#environment-variables)

---

## What This Is

This is my personal infrastructure project — a fully containerized platform that hosts my resume website with a contact form, email notifications, monitoring dashboards, and SSO-protected internal tooling. Everything runs via Docker Compose on a single Linux host.

The goals were simple:
- Learn how production SRE infrastructure actually works by building it
- Run it securely with no open firewall ports
- Build real observability, not just "is the container running?"
- Make architectural decisions and understand the trade-offs behind each one

---

## Architecture Overview

```
                        Internet
                           │
                    Cloudflare Edge
                    (SSO / Zero Trust)
                           │
                    Cloudflare Tunnel
                    (encrypted, outbound-only)
                           │
                    ┌──────▼──────┐
                    │    NGINX    │  ← Reverse Proxy / Static Hosting
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
   │   Backend   │  │   Grafana   │  │  Prometheus │
   │  (Node.js)  │  │ (Dashboards)│  │  (Metrics)  │
   └──────┬──────┘  └─────────────┘  └────────────┘
          │
          │  Kafka Topic: email-jobs
          │
   ┌──────▼──────┐
   │    Email    │
   │  Consumer   │  ← Async email sender
   └─────────────┘
          │
   ┌──────▼──────┐
   │  PostgreSQL │  ← Contact form submissions
   └─────────────┘

  Supporting Services:
  ├── Loki           ← Log aggregation
  ├── mtail          ← NGINX log parsing → Prometheus metrics
  ├── Docker Socket  ← Read-only Docker API proxy (hardened)
  │   Proxy
  └── Kafka + Zookeeper (or KRaft) ← Message broker
```

All services communicate over a private Docker bridge network (`internal`). Nothing is exposed to the host except port 80, which only accepts the Cloudflare Tunnel connection.

---

## Services Breakdown

### NGINX — Reverse Proxy & Static Server
- Serves the static resume/portfolio website from `/usr/share/nginx/html`
- Routes API requests to the backend Node.js service
- Routes `/grafana` to the Grafana container for internal dashboards
- Writes access logs to a named Docker volume (`nginx-logs`) shared with mtail
- Built from a custom Dockerfile to bake in configuration

**Why custom Dockerfile instead of just volume-mounting the config?**
Baking the config into the image makes the container self-contained and easier to reason about. Volume mounting is fine for development but creates a runtime dependency on the host filesystem.

---

### Backend App — Node.js API
- Handles contact form submissions from the frontend
- Validates input, writes submission to PostgreSQL
- Publishes an `email-job` event to Kafka instead of sending email directly
- Uses `express`, `pg`, `kafkajs`, `nodemailer`

**Why publish to Kafka instead of sending email inline?**
See [Trade-offs](#trade-offs--design-decisions).

---

### Email Consumer — Kafka Consumer
- Subscribes to the `email-jobs` Kafka topic
- Reads the message, formats it, and sends via Gmail SMTP (nodemailer)
- Completely decoupled from the backend — can be restarted independently
- Writes delivery status back to PostgreSQL

---

### Apache Kafka — Message Broker
- Single-broker setup
- Decouples email sending from HTTP request handling
- Enables retry logic — if the email consumer crashes, messages wait in Kafka
- Topic: `email-jobs`

---

### PostgreSQL — Primary Database
- Stores contact form submissions
- Persistent via named Docker volume (`postgres_data`)
- Used by both backend (write) and email consumer (status update)

---

### Cloudflare Tunnel (`cloudflared`)
- Establishes an outbound-only encrypted tunnel to Cloudflare's edge
- No inbound ports need to be opened on the firewall
- Cloudflare handles TLS termination, DDoS protection, and SSO enforcement
- Configured with `--protocol http2` for performance
- Health check runs `cloudflared tunnel info` every 15s

---

### Grafana — Dashboards
- Visualizes metrics from Prometheus and logs from Loki
- Protected behind Cloudflare SSO (not exposed publicly)
- Persistent storage via `grafana_data` volume

---

### Prometheus — Metrics Collection
- Scrapes metrics from NGINX (via mtail), Node.js backend, and container stats
- Persistent storage via `prometheus_data` volume

---

### Loki — Log Aggregation
- Collects logs from all containers
- Queried directly from Grafana using LogQL
- Persistent via `loki_data` volume

---

### mtail — Log Metric Extractor
- Reads NGINX access logs from the shared `nginx-logs` volume
- Parses log lines and exports Prometheus metrics (request counts, status codes, latency buckets)
- Bridges the gap between unstructured logs and structured metrics

---

### Docker Socket Proxy
- Wraps the Docker socket (`/var/run/docker.sock`) with a read-only HTTP proxy
- Only `CONTAINERS: 1` (read) is enabled — `POST`, `DELETE`, `EXEC` are all disabled
- Prevents any service from gaining write access to the Docker daemon
- Used by Grafana or monitoring tools that need container metadata

---

## Networking Design

All services run on a single Docker bridge network called `internal`. No service is directly reachable from outside the host except through the Cloudflare Tunnel.

```
Host Machine
└── Docker bridge: internal
    ├── nginx          (port 80 mapped to host)
    ├── backend-app    (internal only)
    ├── email-consumer (internal only)
    ├── kafka          (internal only)
    ├── postgres       (internal only)
    ├── prometheus     (internal only)
    ├── grafana        (internal only)
    ├── loki           (internal only)
    ├── mtail          (internal only)
    ├── socket-proxy   (internal only)
    └── cloudflared    (outbound tunnel to Cloudflare)
```

**DNS resolution** between containers uses Docker's internal DNS — services call each other by container name (e.g., `http://rajcv-backend:3000`).

---

## Observability Stack

| Signal | Tool | How |
|--------|------|-----|
| Metrics | Prometheus | Scrapes exporters + mtail |
| Logs | Loki | Container log driver or promtail |
| Dashboards | Grafana | Prometheus + Loki datasources |
| NGINX metrics | mtail | Parses access log volume |
| Alerting | (future) | Grafana alerts or Alertmanager |

The nginx-logs named volume is the key bridge — NGINX writes to it, mtail reads from it. This avoids needing a sidecar container or modifying NGINX itself.

---

## Security Decisions

| Decision | Reason |
|----------|--------|
| Cloudflare Tunnel — no open ports | Eliminates the entire class of direct attack on the host. No port scanning, no brute force on SSH via public IP. |
| SSO via Cloudflare Access | Identity enforcement at the edge before traffic ever reaches the server. |
| Docker socket proxy (read-only) | Never mount `/var/run/docker.sock` directly into a container. A compromised container with write access to the Docker socket = root on the host. |
| All services on internal network | Services are not reachable from outside Docker — only NGINX is the entry point. |
| Secrets via environment variables | Credentials not hardcoded in images. Tunnel token passed via `${CLOUDFLARE_TUNNEL_TOKEN}` with a required check (`:?` syntax fails fast if unset). |
| DNS set to 1.1.1.1 / 1.0.0.1 for cloudflared | Avoids DNS rebinding issues and ensures reliable tunnel resolution. |

---

## Trade-offs & Design Decisions

### 1. Kafka for a Single Contact Form — Isn't That Overkill?

**Yes. That was the point.**

I could have sent the email synchronously inside the HTTP handler in 5 lines. Instead I used Kafka because:

- I wanted to learn how event-driven decoupling works in practice
- If the email service is slow or down, the HTTP response to the user is not affected
- The consumer can be restarted, redeployed, or scaled without touching the backend
- Messages persist in Kafka — no email is lost if the consumer crashes mid-send

**The real trade-off:** Operational complexity. I now maintain a Kafka broker, a consumer group, topic configuration, and offset management for what is functionally a queue that sends 2 emails a week. At this scale, a simple database-backed job queue (like pg-boss or BullMQ with Redis) would be more appropriate. I chose Kafka deliberately to learn it.

---

### 2. Docker Compose Instead of Kubernetes

**Single host = Docker Compose is the right tool.**

Kubernetes would add enormous complexity (control plane, etcd, kubelet, CNI plugins) for zero benefit on one machine. The trade-off is clear:

| | Docker Compose | Kubernetes |
|---|---|---|
| Operational overhead | Low | High |
| Multi-node scaling | No | Yes |
| Self-healing | Basic (restart policies) | Advanced |
| Right for 1 host | ✅ | ❌ |

If this were multi-node or needed pod autoscaling, I'd use K3s or a managed cluster.

---

### 3. Single Kafka Broker — No Replication

**Acceptable for personal use. Not acceptable in production.**

A single Kafka broker means if it goes down, messages are unavailable until it restarts. There's no ISR (in-sync replicas), no leader election. For a contact form on a personal site, this is fine. In production, you'd want:
- Minimum 3 brokers
- Replication factor ≥ 2
- A dead letter queue for failed consumer messages

---

### 4. Cloudflare Tunnel Over Self-Signed TLS + Open Port

This was an explicit security-over-simplicity trade-off.

The simpler path: open port 443, get a Let's Encrypt cert, done. I chose the tunnel because:
- No open ports = massively reduced attack surface
- Cloudflare handles TLS, HTTPS redirects, and certificate renewal
- SSO is trivially added at the Cloudflare Access layer
- I get DDoS protection for free

The cost: dependency on Cloudflare. If Cloudflare is down, my site is unreachable even if my server is fine. I've accepted that trade-off.

---

### 5. Named Volume for NGINX Logs (mtail Integration)

Instead of using a log shipping sidecar or modifying NGINX to push metrics directly, I share the log file via a named Docker volume between NGINX and mtail. This is a deliberate low-coupling design:

- NGINX doesn't know mtail exists
- mtail doesn't need any NGINX configuration changes
- The volume is the interface

**Trade-off:** File-based log sharing is slightly less real-time than a direct stream. For a personal site, the latency is irrelevant.

---

### 6. Read-Only Docker Socket Proxy

Mounting `/var/run/docker.sock` directly into any container is a common but dangerous pattern. A container with write access to the socket can start new containers, exec into existing ones, or mount host paths — effectively gaining root on the host.

The socket proxy limits this to read-only `GET /containers/*` calls. It's a small addition that closes a significant privilege escalation vector.

---

## Known Limitations & What I'd Change at Scale

| Current Limitation | Production Fix |
|---|---|
| Single Kafka broker, no replication | 3-broker cluster, RF=2, min ISR=1 |
| No dead letter queue for failed emails | DLQ topic + alerting on consumer lag |
| Passwords in environment variables | HashiCorp Vault or Docker Secrets |
| No horizontal scaling | Move to K3s or managed Kubernetes |
| Single host, no HA | Active-passive with shared storage or cloud-native services |
| No alerting configured in Prometheus | Alertmanager + PagerDuty/OpsGenie |
| NGINX metrics via mtail (file parsing) | NGINX Prometheus exporter (native) |
| No backup for PostgreSQL | Automated pg_dump to object storage (S3/R2) |

---

## Running Locally

```bash
# Clone the repo
git clone https://github.com/yourusername/rajcv-infra.git
cd rajcv-infra

# Copy and fill in your environment variables
cp .env.example .env

# Start everything
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | ✅ | Your Cloudflare Tunnel token from Zero Trust dashboard |
| `POSTGRES_USER` | ✅ | PostgreSQL username |
| `POSTGRES_PASSWORD` | ✅ | PostgreSQL password |
| `GMAIL_USER` | ✅ | Gmail address for sending contact form emails |
| `GMAIL_PASS` | ✅ | Gmail App Password (not your account password) |

> ⚠️ Never commit your `.env` file. Add it to `.gitignore`.

---

## What I Learned Building This

- How event-driven architectures decouple producers and consumers in practice
- Why the Docker socket proxy pattern exists and when to use it
- How Cloudflare Tunnel works at a protocol level (HTTP/2 multiplexing over an outbound connection)
- How to wire Prometheus, Loki, and Grafana into a unified observability stack
- The real meaning of "zero open ports" and what attack surface reduction looks like
- How to read a production-grade `docker-compose.yml` and reason about service dependencies, health checks, and volume design

---

*Built for learning. Designed for production thinking.*
