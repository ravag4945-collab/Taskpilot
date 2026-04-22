require('dotenv').config();
const Groq = require('groq-sdk'); 
const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); 
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Load Google Credentials (Render will inject this via Secret Files)
const credentials = JSON.parse(fs.readFileSync('credentials.json')).web;

// Dynamically handle the redirect URI for both localhost and Render
// Ensure you add your Render URL to Google Cloud Console > Authorized Redirect URIs
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/auth/callback` 
    : credentials.redirect_uris[0];

const oAuth2Client = new google.auth.OAuth2(
    credentials.client_id, 
    credentials.client_secret, 
    REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
    res.redirect(oAuth2Client.generateAuthUrl({ 
        access_type: 'offline', 
        scope: ['https://www.googleapis.com/auth/gmail.readonly'] 
    }));
});

app.get('/auth/callback', async (req, res) => {
    try {
        const { tokens } = await oAuth2Client.getToken(req.query.code);
        oAuth2Client.setCredentials(tokens); 
        res.redirect('/?loggedin=true');
    } catch (err) {
        console.error("Auth Error:", err);
        res.send("Authentication failed. Please try again.");
    }
});

app.get('/api/auto-process', async (req, res) => {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
        
        // Fetch last 7 days, excluding promotions and social
        const response = await gmail.users.messages.list({ 
            userId: 'me', 
            q: 'newer_than:7d -category:promotions -category:social', 
            maxResults: 12 
        });
        
        const messages = response.data.messages || [];
        if (messages.length === 0) return res.json([]);
        
        // 1. Fetch exact data from Google (IDs are safe on the server)
        const detailedEmails = await Promise.all(messages.map(async (msg) => {
            const full = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const subject = full.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject';
            return {
                id: msg.threadId, // Stored safely
                subject: subject, 
                snippet: full.data.snippet
            };
        }));

        // 2. Prepare text for AI (No IDs sent to AI)
        const emailTexts = detailedEmails.map((e, i) => `[Email #${i+1}] Subject: ${e.subject} | Body: ${e.snippet}`);

        const prompt = `You are a productivity agent. You MUST return exactly ${detailedEmails.length} JSON objects.
        Format: [{"priority": "high", "title": "Short summary"}]
        
        Emails:
        ${emailTexts.join('\n\n')}`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            response_format: { "type": "json_object" }
        });
        
        let result = JSON.parse(completion.choices[0].message.content.trim());
        const aiTasks = Array.isArray(result) ? result : (result.tasks || Object.values(result)[0]);

        // 3. Zip AI ratings together with Google's safe IDs
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
        res.status(500).json({ error: error.message });
    }
});

// Production Port Setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 TaskPilot Server Live on port ${PORT}`);
});