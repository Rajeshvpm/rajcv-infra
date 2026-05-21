const nodemailer = require('nodemailer');
const { Kafka } = require('kafkajs');
const { Pool } = require('pg');

const kafka = new Kafka({
  brokers: ['kafka:9092'],
  clientId: 'email-consumer'
});

const consumer = kafka.consumer({ groupId: 'email-service' });

const db = new Pool({
  host: 'rajcv-postgres',
  database: 'rajcv_services',
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function run() {
  await consumer.connect();
  console.log('Consumer connected to Kafka');

  await consumer.subscribe({
    topics: ['service.request.created', 'service.request.closed'],
    fromBeginning: false
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const data = JSON.parse(message.value.toString());
      console.log(`Event received → topic: ${topic}, ticketId: ${data.ticketId}`);

      // ── TICKET CREATED → send acknowledgement email ──
      if (topic === 'service.request.created') {
        try {
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: data.targetEmail,
            subject: `[#${data.ticketId}] We received your request — ${data.emailSubject}`,
            text: `Hi ${data.name},

Thank you for reaching out. We have received your request and it is now being processed.

─────────────────────────────
Ticket ID   : #${data.ticketId}
Status      : PENDING
Request     : ${data.task || data.description || 'N/A'}
${data.cost         ? `Budget      : ${data.cost}\n` : ''}\
${data.availability ? `Availability: ${data.availability}\n` : ''}\
─────────────────────────────

We will get back to you once your request is resolved.

rajcv.online`
          });

          console.log(`Acknowledgement email sent for ticket #${data.ticketId}`);

          // Mark email sent in DB
          if (data.ticketId) {
            await db.query(
              `UPDATE service_requests SET email_sent = true WHERE id = $1`,
              [data.ticketId]
            );
            console.log(`DB updated email_sent=true for ticket #${data.ticketId}`);
          }

        } catch (err) {
          console.error(`Failed to send acknowledgement email for ticket #${data.ticketId}:`, err.message);
        }
      }

      // ── TICKET CLOSED → send resolution email ──
      if (topic === 'service.request.closed') {
        try {
          // Fetch full ticket details from DB
          const result = await db.query(
            `SELECT * FROM service_requests WHERE id = $1`,
            [data.ticketId]
          );
          const ticket = result.rows[0];

          if (!ticket) {
            console.error(`Ticket #${data.ticketId} not found in DB`);
            return;
          }

          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: ticket.target_email,
            subject: `[#${data.ticketId}] Your request has been resolved`,
            text: `Hi ${ticket.name},

Great news! Your service request has been reviewed and marked as resolved.

─────────────────────────────
Ticket ID   : #${data.ticketId}
Status      : CLOSED ✓
Request     : ${ticket.task || ticket.description || 'N/A'}
Resolved on : ${new Date(data.closedAt).toLocaleString()}
─────────────────────────────

If you have any further questions, feel free to raise a new request.

rajcv.online`
          });

          console.log(`Resolution email sent for ticket #${data.ticketId}`);
          // ── CREDIT SETTLEMENT ─────────────────────────────
          // ticket.raised_for = person who was asked to serve
          // ticket.name       = person who raised the request
          // raised_for gets +5 for serving, name already lost 5 on raise
          if (ticket.raised_for) {
            await db.query(
              `UPDATE users SET credits = credits + 5 WHERE name=$1`,
              [ticket.raised_for.toLowerCase()]
            );
            console.log(`Credits +5 → ${ticket.raised_for} (served favour #${data.ticketId})`);
          }
        } catch (err) {
          console.error(`Failed to send resolution email for ticket #${data.ticketId}:`, err.message);
        }
      }
    }
  });
}

run().catch(err => {
  console.error('Consumer crashed:', err.message);
  process.exit(1);
});
