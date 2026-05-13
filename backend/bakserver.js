const express = require('express');
const nodemailer = require('nodemailer');
const app = express();
// This allows the server to read the JSON data sent from your HTML page
app.use(express.json());

// --- CONFIGURATION SECTION ---
const GMAIL_USER = 'rajesh.cs225@gmail.com';
const GMAIL_PASS = 'yhom vnwc hzvv ukkf'; // Your 16-character Gmail App Password

const MAIL_FOR_RAJESH = 'gammu661996@gmail.com'; // Special mail for name "Rajesh"
const MAIL_FOR_ID_1 = 'rajesh.cs225@gmail.com';    // Default for ID 1
// ------------------------------

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
    }
});
app.post('/submit', (req, res) => {
    // We only extract the actual data fields now
    const { name, task, cost, availability, description } = req.body;

    let targetEmail = "";
    let emailSubject = "";
    let emailBody = "";

    // --- LOGIC: CHOOSE RECIPIENT ---
    if (name && name.toLowerCase() === 'rajesh') {
        targetEmail = MAIL_FOR_RAJESH;
    } else {
        // Otherwise, it's a general help request
        targetEmail = MAIL_FOR_ID_1;
    }

    // --- LOGIC: FORMAT CONTENT ---
    if (task) {
        emailSubject = `Service Request Raised by ${name}`;
        emailBody = `
Hi ,

You have received a new  Service request.

Details:
------------------------------------------
Request Raised by : ${name}
Service Tasks : ${task}
Budget/Cost    : ${cost}
Preferred Time : ${availability}
------------------------------------------

Sent via rajcv.online
        `;
    } else {
        emailSubject = `New Favour/Help Request from ${name}`;
        emailBody = `
Hi ,

${name} has reached out for a favour or help.

Message Content:
------------------------------------------
"${description}"
------------------------------------------

Sent via rajcv.online
        `;
    }

    const mailOptions = {
        from: GMAIL_USER,
        to: targetEmail,
        subject: emailSubject,
        text: emailBody
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) return res.status(500).send("Error sending mail");
        res.status(200).send("Success");
    });
});

app.listen(5000, () => console.log('Backend server running on port 5000'));
