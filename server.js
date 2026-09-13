/**
 * MEG AUTO-REPLY BOT
 *
 * WhatsApp AI bot that replies to messages like YOU (the owner).
 *
 * Features:
 *   - Uses Baileys (official WhatsApp Web library) with Chrome browser fingerprint
 *   - Gemini AI for human-like replies (English, Kiswahili, and 50+ languages)
 *   - Typing indicators before replying (looks like you're typing)
 *   - .active command to toggle auto-reply ON/OFF
 *   - Always online 24/7
 *   - Multi-user pairing site (like YOBBY MD)
 *
 * Owner: Yobby King (wa.me/254795314221)
 * Gemini API Key: configured in source (no env var needed)
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const P = require('pino');

const PORT = process.env.PORT || 3000;
const BOT_NAME = 'MEG AUTO-REPLY BOT';

// ★ Gemini API Key — set as env var on Render (optional — local fallback works without it)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ★ Owner info — used in the AI prompt so the bot acts like the owner
const OWNER_NAME = 'Yobby';
const OWNER_STATUS = 'Yobby is at school waiting for KCSE exam. Wish him success 🥹';

// ★ Bot state
let botActive = false; // .active toggles this
let sock = null;
let connectionState = { connected: false, user: null };
let pairingCode = null;
let pairingResolve = null;

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ GEMINI AI REPLY ============

async function generateAIReply(senderName, incomingMessage, conversationHistory) {
  const systemPrompt = `You are ${OWNER_NAME}, a Kenyan student. You are texting on WhatsApp.

IMPORTANT: You ARE ${OWNER_NAME}. Never say you are a bot or AI. You are a real person texting.

Your current situation: ${OWNER_STATUS}

Rules:
- Detect the language of the incoming message and reply in the SAME language (English, Kiswahili, Sheng, French, etc.)
- Keep replies SHORT (1-3 sentences max) — like real WhatsApp texts
- Use casual texting language (no formal grammar)
- Be friendly, natural, and human
- If someone asks who you are, say: "Hey, ${OWNER_NAME} here! ${OWNER_STATUS} Who are you?"
- If someone asks about exams, talk about KCSE naturally
- Use emojis sparingly like a real person would
- NEVER mention AI, bot, or automation
- Match the vibe — if they're serious, be serious. If casual, be casual.

The person texting you is: ${senderName}

Reply with ONLY the WhatsApp message text, nothing else.`;

  try {
    const userContent = conversationHistory.length > 0
      ? conversationHistory.map(m => `${m.role === 'user' ? 'Them' : 'Me'}: ${m.content}`).join('\n') + `\nThem: ${incomingMessage}\nMe:`
      : `Them: ${incomingMessage}\nMe:`;

    // Try Gemini 1.5 Flash first (fast + free tier)
    const models = ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
    
    for (const model of models) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userContent }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 150, topP: 0.95 },
          },
          { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );

        const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply && reply.trim().length > 0) {
          return reply.trim().slice(0, 500);
        }
      } catch (e) {
        const status = e.response?.status;
        if (status === 404) continue; // model not found, try next
        if (status === 400 && e.response?.data?.error?.message?.includes('location')) {
          // Gemini blocked in this region — use fallback
          return localFallbackReply(incomingMessage, senderName);
        }
        continue;
      }
    }
    
    // If all Gemini models failed, use local fallback
    return localFallbackReply(incomingMessage, senderName);
  } catch (e) {
    console.warn('[AI] Gemini failed:', e.message);
    return localFallbackReply(incomingMessage, senderName);
  }
}

function localFallbackReply(text, senderName) {
  const t = text.toLowerCase();
  
  if (/^(hi|hey|hello|hallo|hola|jambo|mambo|niaje|sasa)/.test(t)) {
    return `Hey! ${OWNER_NAME} here 😊 ${OWNER_STATUS} Who are you?`;
  }
  if (/who are you|who is this|who r u/.test(t)) {
    return `I'm ${OWNER_NAME} 😊 ${OWNER_STATUS} Who are you?`;
  }
  if (/exam|kcse|school|success|best of luck/.test(t)) {
    return `Asante! Niko shule doing KCSE. Wish me success 🥹`;
  }
  if (/how are you|umeshindaje|habari|mambo vipi/.test(t)) {
    return `Niko poa! Just waiting for KCSE exam. Wewe je?`;
  }
  if (/asante|thanks|thank you/.test(t)) {
    return `Karibu! 😊`;
  }
  if (/\?$/.test(t)) {
    return `Hmm, good question 🤔 Lemme get back to you after exams lol`;
  }
  
  const replies = [
    `Haha true 😂`,
    `Yeah I feel you`,
    `For real! 💯`,
    `Niko shule, exams are keeping me busy`,
    `Wish me success in KCSE 🥹`,
    `I'll reply properly after exams, for now just know I appreciate you texting 💪`,
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

// ============ CONVERSATION MEMORY ============
const conversations = new Map(); // phoneNumber → [{role, content}]

function addToConversation(phoneNumber, role, content) {
  if (!conversations.has(phoneNumber)) {
    conversations.set(phoneNumber, []);
  }
  const history = conversations.get(phoneNumber);
  history.push({ role, content });
  // Keep only last 10 messages
  if (history.length > 10) {
    history.shift();
  }
}

// ============ BAILEYS WHATSAPP BOT ============

const AUTH_DIR = path.join(__dirname, 'auth_state');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = P({ level: 'warn' }, P.destination({ sync: true }));

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[BOT] Using Baileys v${version}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    // ★ Chrome browser fingerprint (as requested)
    browser: Browsers.appropriate('Chrome'),
    defaultQueryTimeoutMs: 60000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && pairingResolve) {
      // Socket ready for pairing code
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[BOT] Connection closed (${statusCode}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot().catch(e => console.error('[BOT] Reconnect failed:', e.message)), 3000);
      } else {
        // Logged out — clear auth
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        connectionState = { connected: false, user: null };
      }
    } else if (connection === 'open') {
      const user = sock.user;
      connectionState = {
        connected: true,
        user: { id: user.id, name: user.name },
        number: user.id.split(':')[0],
      };
      console.log(`\n╔══════════════════════════════════════════════╗`);
      console.log(`║  ✅ ${BOT_NAME} CONNECTED!                       ║`);
      console.log(`║  👤 Number: ${user.id.split(':')[0].padEnd(33)}║`);
      console.log(`║  📛 Name: ${(user.name || 'Unknown').padEnd(36)}║`);
      console.log(`║  🤖 AI: Gemini • Bot: ${botActive ? '🟢 ACTIVE' : '🔴 OFF'}${' '.repeat(7)}║`);
      console.log(`╚══════════════════════════════════════════════╝\n`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const text = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';
      if (!text) continue;

      const senderJid = msg.key.participant || msg.key.remoteJid;
      const senderNum = senderJid.split('@')[0].split(':')[0];
      const senderName = msg.pushName || senderNum;

      console.log(`[MSG] From ${senderName} (${senderNum}): "${text.slice(0, 60)}"`);

      // === .active command (toggle bot ON/OFF) ===
      if (text.toLowerCase().trim() === '.active') {
        botActive = !botActive;
        try {
          await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
          await new Promise(r => setTimeout(r, 800));
          await sock.sendMessage(msg.key.remoteJid, {
            text: botActive
              ? `🟢 *AUTO-REPLY ACTIVATED*\n\nHey! ${OWNER_NAME} here. ${OWNER_STATUS}\n\nI'll be replying to messages now. Type anything! 😊`
              : `🔴 *AUTO-REPLY DEACTIVATED*\n\n${OWNER_NAME} is going offline now. Catch you later! 👋`,
          }, { quoted: msg });
          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
        } catch (e) {}
        continue;
      }

      // === .menu command ===
      if (text.toLowerCase().trim() === '.menu') {
        try {
          await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
          await new Promise(r => setTimeout(r, 1000));
          await sock.sendMessage(msg.key.remoteJid, {
            text: `╔═══════════════════════════════════════╗
║      ${BOT_NAME} - MENU                  ║
╚═══════════════════════════════════════╝

🤖 *AI:* Gemini (multi-language)
👤 *Owner:* ${OWNER_NAME}
📚 *Status:* ${OWNER_STATUS}
🟢 *Bot:* ${botActive ? 'ACTIVE' : 'OFF'}

📝 *Commands:*
  .active → Toggle auto-reply
  .menu   → Show this menu

_Type .active to start!_`,
          }, { quoted: msg });
          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
        } catch (e) {}
        continue;
      }

      // === Auto-reply (only if bot is active) ===
      if (!botActive) continue;

      // Don't reply in groups (only DMs)
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      // Don't reply to status broadcasts
      if (msg.key.remoteJid === 'status@broadcast') continue;

      try {
        // ★ Show typing indicator (looks human)
        await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

        // ★ Get conversation history for context
        const history = conversations.get(senderNum) || [];

        // ★ Generate AI reply
        const reply = await generateAIReply(senderName, text, history);

        // ★ Save to conversation history
        addToConversation(senderNum, 'user', text);
        addToConversation(senderNum, 'assistant', reply);

        // ★ Human-like delay (1-3 seconds depending on reply length)
        const delay = Math.min(3000, Math.max(1000, reply.length * 30));
        await new Promise(r => setTimeout(r, delay));

        // ★ Send reply
        await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: msg });

        // ★ Stop typing indicator
        await sock.sendPresenceUpdate('paused', msg.key.remoteJid);

        console.log(`[REPLY] To ${senderName}: "${reply.slice(0, 60)}"`);
      } catch (e) {
        console.error('[REPLY] Error:', e.message);
        try { await sock.sendPresenceUpdate('paused', msg.key.remoteJid); } catch {}
      }
    }
  });

  return sock;
}

// ============ PAIRING CODE ============

async function getPairingCode(phoneNumber) {
  if (!sock) throw new Error('Bot not initialized');
  
  let waited = 0;
  while (!sock.wsReady && waited < 30) {
    await new Promise(r => setTimeout(r, 1000));
    waited++;
  }

  const code = await sock.requestPairingCode(phoneNumber);
  return code;
}

// ============ API ENDPOINTS ============

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: BOT_NAME,
    connected: connectionState.connected,
    active: botActive,
    number: connectionState.number || null,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    botName: BOT_NAME,
    version: '1.0.0',
    connected: connectionState.connected,
    active: botActive,
    owner: OWNER_NAME,
    ownerStatus: OWNER_STATUS,
    number: connectionState.number || null,
    name: connectionState.user?.name || null,
  });
});

app.post('/api/pair', async (req, res) => {
  try {
    const phoneNumber = (req.body?.phoneNumber || '').replace(/\D/g, '');
    if (!phoneNumber || !/^\d{8,15}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phone number. Use digits only with country code.' });
    }

    if (connectionState.connected) {
      return res.status(409).json({ error: 'Already paired. Bot is connected.' });
    }

    const code = await getPairingCode(phoneNumber);

    res.json({
      success: true,
      code,
      phoneNumber,
      expiresIn: 90,
      instructions: [
        '1. Open WhatsApp on your phone',
        '2. Tap Settings → Linked Devices → Link a Device',
        '3. Tap "Link with phone number instead"',
        '4. Enter the code below:',
      ],
    });
  } catch (e) {
    console.error('[PAIR ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/activate', (req, res) => {
  botActive = true;
  res.json({ ok: true, active: true, message: 'Bot is now ACTIVE — will auto-reply to messages.' });
});

app.post('/api/deactivate', (req, res) => {
  botActive = false;
  res.json({ ok: true, active: false, message: 'Bot is now OFF.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============

async function start() {
  // Start Express server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║  ${BOT_NAME} v1.0                              ║`);
    console.log(`║  ★ Gemini AI + Baileys + Chrome              ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
    console.log(`\n🌐 Pairing site: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/status`);
    console.log(`💚 Health: http://localhost:${PORT}/health\n`);
  });

  // Start WhatsApp bot
  try {
    await startBot();
  } catch (e) {
    console.error('[FATAL] Bot failed to start:', e);
  }

  process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
  process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
}

start();
