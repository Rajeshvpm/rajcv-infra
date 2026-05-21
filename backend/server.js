const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');

const app = express();
app.use(express.json());
app.use(express.static('/app'));

// --- POSTGRES ---
const db = new Pool({
  host: 'rajcv-postgres',
  port: 5432,
  database: 'rajcv_services',
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

// --- KAFKA ---
const kafka = new Kafka({
  brokers: ['kafka:9092'],
  clientId: 'rajcv-backend'
});
const producer = kafka.producer();

producer.connect()
  .then(() => console.log('Kafka producer connected'))
  .catch(err => console.error('Kafka producer failed:', err.message));

// --- HELPERS ---
const MAIL_FOR_RAJESH = 'gammu661996@gmail.com';
const MAIL_FOR_DEFAULT = 'rajesh.cs225@gmail.com';

function log(requestId, stage, data) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    requestId,
    stage,
    ...data
  }));
}

// ── SUBMIT ROUTE ──────────────────────────────────────────
app.post('/submit', async (req, res) => {
  const requestId = Date.now().toString(36).toUpperCase();
  const { name, task, cost, availability, description, raisedFor } = req.body;

  log(requestId, 'REQUEST_RECEIVED', { name, task });

  // Determine recipient
  const targetEmail = (name && name.toLowerCase() === 'rajesh')
    ? MAIL_FOR_RAJESH
    : MAIL_FOR_DEFAULT;

  const type = task ? 'service' : 'favour';
  // ── CREDIT CHECK (favour requests only) ──────────────────
  if (!task) {
    const userCheck = await db.query(
      `SELECT credits FROM users WHERE name=$1`,
      [name.trim().toLowerCase()]
    );
    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'NOT_REGISTERED' });
    }
    if (userCheck.rows[0].credits < 5) {
      return res.status(403).json({ error: 'INSUFFICIENT_CREDITS' });
    }
    // deduct immediately on raise
    await db.query(
      `UPDATE users SET credits = credits - 5 WHERE name=$1`,
      [name.trim().toLowerCase()]
    );
  }

  const emailSubject = task
    ? `Service Request Raised by ${name}`
    : `New Favour/Help Request from ${name}`;

  const emailBody = task
    ? `Hi,\nNew Service Request.\n\nFrom: ${name}\nTask: ${task}\nBudget: ${cost}\nTime: ${availability}\n\nSent via rajcv.online`
    : `Hi,\n${name} needs help.\n\nMessage: "${description}"\n\nSent via rajcv.online`;

  // 1. SAVE TO DB
  let ticketId = null;
  try {
    const result = await db.query(
      `INSERT INTO service_requests
        (name, type, task, cost, availability, description, target_email, status, raised_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING id`,
      [name, type, task||null, cost||null, availability||null, description||null, targetEmail, raisedFor||null]
    );
    ticketId = result.rows[0].id;
    log(requestId, 'DB_SAVED', { ticketId });
  } catch (err) {
    log(requestId, 'DB_FAILED', { error: err.message });
  }

  // 2. PUBLISH TO KAFKA → consumer will send the email
  try {
    await producer.send({
      topic: 'service.request.created',
      messages: [{
        key: String(ticketId || Date.now()),
        value: JSON.stringify({
          ticketId,
          name,
          type,
          task,
          raisedFor,
          cost,
          availability,
          description,
          targetEmail,
          emailSubject,
          emailBody,
          createdAt: new Date().toISOString()
        })
      }]
    });
    log(requestId, 'KAFKA_PUBLISHED', { ticketId, topic: 'service.request.created' });
  } catch (err) {
    log(requestId, 'KAFKA_FAILED', { error: err.message });
    // No fallback — consumer handles all emails now
  }

  res.status(200).json({ success: true, ticketId });
});

// ── GET ALL TICKETS ───────────────────────────────────────
app.get('/tickets', async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? `SELECT * FROM service_requests WHERE status=$1 ORDER BY created_at DESC`
      : `SELECT * FROM service_requests ORDER BY created_at DESC`;
    const result = await db.query(query, status ? [status] : []);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLOSE A TICKET ────────────────────────────────────────
app.patch('/tickets/:id/close', async (req, res) => {
  const { id } = req.params;
  const { closedBy } = req.body;
  try {
    await db.query(
      `UPDATE service_requests
       SET status='CLOSED', closed_at=NOW(), closed_by=$1
       WHERE id=$2`,
      [closedBy || 'admin', id]
    );

    // Publish to Kafka → consumer sends resolution email
    await producer.send({
      topic: 'service.request.closed',
      messages: [{
        key: String(id),
        value: JSON.stringify({
          ticketId: id,
          closedBy: closedBy || 'admin',
          closedAt: new Date().toISOString()
        })
      }]
    });

    log('CLOSE', 'TICKET_CLOSED', { ticketId: id });
    res.json({ success: true, message: `Ticket #${id} closed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REGISTER USER ─────────────────────────────────────────
app.post('/users/register', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await db.query(
      `INSERT INTO users (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
       RETURNING id, name, credits`,
      [name.trim().toLowerCase()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL REGISTERED USERS ──────────────────────────────
app.get('/users', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT name, credits FROM users ORDER BY name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SINGLE USER CREDITS ───────────────────────────────
app.get('/users/:name/credits', async (req, res) => {
  const name = req.params.name.toLowerCase();
  try {
    const result = await db.query(
      `SELECT name, credits FROM users WHERE name=$1`, [name]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(3000, () => console.log('Server running on port 3000'));
