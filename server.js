require('dotenv').config();
const Groq = require('groq-sdk'); 
const express = require('express');
const { google } = require('googleapis');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); 
const app = express();

app.use(express.json());
app.use(express.static('public'));

// FIX: Instead of reading credentials.json from the disk (which fails on Vercel),
// we parse it from an Environment Variable.
let credentials;
try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS).web;
} catch (err) {
    console.error("Missing or invalid GOOGLE_CREDENTIALS environment variable");
}

const REDIRECT_URI = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}/auth/callback` 
    : (credentials ? credentials.redirect_uris[0] : 'http://localhost:3000/auth/callback');

const oAuth2Client = new google.auth.OAuth2(
    credentials?.client_id, 
    credentials?.client_secret, 
    REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
    const url = oAuth2Client.generateAuthUrl({ 
        access_type: 'offline', 
        scope: ['https://www.googleapis.com/auth/gmail.readonly'] 
    });
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    try {
        const { tokens } = await oAuth2Client.getToken(req.query.code);
        oAuth2Client.setCredentials(tokens);
        res.send("✅ Authentication successful! You can close this tab and click 'Run Agent'.");
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).send("Authentication failed.");
    }
});

app.get('/run-agent', async (req, res) => {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
        const response = await gmail.users.messages.list({ userId: 'me', maxResults: 5 });
        
        if (!response.data.messages) return res.json([]);

        const detailedEmails = await Promise.all(response.data.messages.map(async (msg) => {
            const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const subject = detail.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject';
            return { id: msg.id, subject, snippet: detail.data.snippet };
        }));

        const emailTexts = detailedEmails.map((e, i) => `[Email #${i+1}] Subject: ${e.subject} | Body: ${e.snippet}`);

        const prompt = `You are a productivity agent. You MUST return exactly ${detailedEmails.length} JSON objects.
        Format: {"tasks": [{"priority": "high", "title": "Short summary"}]}
        
        Emails:
        ${emailTexts.join('\n\n')}`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            response_format: { "type": "json_object" }
        });
        
        let result = JSON.parse(completion.choices[0].message.content.trim());
        const aiTasks = result.tasks || [];

        const finalTasks = detailedEmails.map((email, index) => {
            const aiData = aiTasks[index] || {}; 
            return {
                id: email.id, 
                priority: aiData.priority || 'low',
                title: aiData.title || email.subject
            };
        });

        res.json(finalTasks);
    } catch (error) {
        console.error("Agent Error:", error);
        res.status(500).json({ error: "Agent failed to run" });
    }
});

// EXPORT THE APP FOR VERCEL (Crucial)
module.exports = app;

// Local development support
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
