/**
 * MEG AUTO-REPLY BOT v2.0
 *
 * WhatsApp AI bot that replies like YOU — now with VOICE NOTES!
 *
 * Features:
 *   - Listens to voice messages (downloads + transcribes to text)
 *   - Replies with voice notes (text-to-speech with cool male voice)
 *   - Also replies with text (for non-voice messages)
 *   - Gemini AI / multiple AI providers (set via env var)
 *   - Typing indicators + human-like delay
 *   - .active command to toggle ON/OFF
 *   - .menu command
 *   - Baileys + Chrome browser
 *   - 24/7 online
 *
 * AI API Options (set one of these as AI_API_KEY env var):
 *   1. Google Gemini  — get key from aistudio.google.com/apikey (starts with AIza...)
 *   2. OpenAI         — get key from platform.openai.com/api-keys
 *   3. Groq           — get key from console.groq.com (FREE, fast)
 *   4. DeepSeek        — get key from platform.deepseek.com (very cheap)
 *   5. Mistral AI     — get key from console.mistral.ai
 *
 * Set AI_PROVIDER env var to choose: gemini / openai / groq / deepseek / mistral
 * Set AI_API_KEY env var with your API key
 *
 * If no AI key set → uses built-in local reply system (still good!)
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
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const P = require('pino');

const PORT = process.env.PORT || 3000;
const BOT_NAME = 'MEG AUTO-REPLY BOT';

// ★ AI configuration (set via env vars on Render)
const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini';
const AI_API_KEY = process.env.AI_API_KEY || '';

// ★ Owner info
const OWNER_NAME = 'Yobby';
const OWNER_STATUS = 'Yobby is at school waiting for KCSE exam. Wish him success 🥹';

// ★ Bot state
let botActive = false;
let sock = null;
let connectionState = { connected: false, user: null };

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ AI REPLY (Multi-provider) ============

async function generateAIReply(senderName, incomingMessage, conversationHistory) {
  const systemPrompt = `You are ${OWNER_NAME}, a Kenyan student. You are texting on WhatsApp.

IMPORTANT: You ARE ${OWNER_NAME}. Never say you are a bot or AI. You are a real person texting.

Your current situation: ${OWNER_STATUS}

Rules:
- Detect the language of the incoming message and reply in the SAME language (English, Kiswahili, Sheng, French, etc.)
- Keep replies SHORT (1-3 sentences max) — like real WhatsApp texts
- Use casual texting language
- Be friendly, natural, and human
- If someone asks who you are, say: "Hey, ${OWNER_NAME} here! ${OWNER_STATUS} Who are you?"
- If someone asks about exams, talk about KCSE naturally
- Use emojis sparingly
- NEVER mention AI, bot, or automation

The person texting you is: ${senderName}

Reply with ONLY the message text.`;

  try {
    if (!AI_API_KEY) {
      return localFallbackReply(incomingMessage, senderName);
    }

    const userContent = conversationHistory.length > 0
      ? conversationHistory.map(m => `${m.role === 'user' ? 'Them' : 'Me'}: ${m.content}`).join('\n') + `\nThem: ${incomingMessage}\nMe:`
      : `Them: ${incomingMessage}\nMe:`;

    // === Try the configured AI provider ===
    let reply = null;

    if (AI_PROVIDER === 'gemini') {
      reply = await tryGemini(systemPrompt, userContent);
    } else if (AI_PROVIDER === 'openai' || AI_PROVIDER === 'groq' || AI_PROVIDER === 'deepseek' || AI_PROVIDER === 'mistral') {
      reply = await tryOpenAICompatible(systemPrompt, userContent);
    }

    if (reply && reply.trim().length > 0) {
      return reply.trim().slice(0, 500);
    }

    return localFallbackReply(incomingMessage, senderName);
  } catch (e) {
    console.warn('[AI] Failed:', e.message);
    return localFallbackReply(incomingMessage, senderName);
  }
}

async function tryGemini(systemPrompt, userContent) {
  const models = ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AI_API_KEY}`,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userContent }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 150, topP: 0.95 },
        },
        { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
      );
      const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply && reply.trim().length > 0) return reply.trim();
    } catch (e) {
      if (e.response?.status === 404) continue;
      if (e.response?.status === 400 && e.response?.data?.error?.message?.includes('location')) return null;
      continue;
    }
  }
  return null;
}

async function tryOpenAICompatible(systemPrompt, userContent) {
  const endpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
  };
  const models = {
    openai: 'gpt-4o-mini',
    groq: 'llama-3.3-70b-versatile',
    deepseek: 'deepseek-chat',
    mistral: 'mistral-large-latest',
  };

  const url = endpoints[AI_PROVIDER];
  const model = models[AI_PROVIDER];

  const res = await axios.post(url, {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: 150,
    temperature: 0.9,
  }, {
    timeout: 15000,
    headers: {
      'Authorization': `Bearer ${AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const reply = res.data?.choices?.[0]?.message?.content;
  return reply ? reply.trim() : null;
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
    `Haha true 😂`, `Yeah I feel you`, `For real! 💯`,
    `Niko shule, exams are keeping me busy`,
    `Wish me success in KCSE 🥹`,
    `I'll reply properly after exams 💪`,
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

// ============ VOICE NOTE: Speech-to-Text (STT) ============

async function transcribeVoiceNote(buffer) {
  // Try Google Speech-to-Text via free API
  try {
    // Use Google's free speech recognition endpoint
    const res = await axios.post(
      'https://speech.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIyqYV3g5N9s',
      buffer,
      { timeout: 15000, headers: { 'Content-Type': 'audio/l16; rate=16000' } }
    );
    // Parse response
    const text = res.data?.result?.[0]?.alternative?.[0]?.transcript;
    if (text) return text;
  } catch (e) {
    console.warn('[STT] Google failed:', e.message);
  }

  // Fallback: return a generic message
  return '[voice message received — could not transcribe]';
}

// ============ VOICE NOTE: Text-to-Speech (TTS) ============

async function generateVoiceNote(text) {
  // Try Google Translate TTS (free, multiple voices)
  try {
    // Detect language to use appropriate TTS voice
    const lang = detectLanguageForTTS(text);

    // Use Google Translate TTS — cool male voice
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text)}`;

    const res = await axios.get(ttsUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://translate.google.com/',
      },
      maxRedirects: 5,
    });

    if (res.data && res.status === 200) {
      return Buffer.from(res.data);
    }
  } catch (e) {
    console.warn('[TTS] Google Translate failed:', e.message);
  }

  // Fallback: StreamElements TTS (cool male voice "Brian")
  try {
    const res = await axios.get(
      `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`,
      { responseType: 'arraybuffer', timeout: 15000 }
    );
    if (res.data) return Buffer.from(res.data);
  } catch (e) {
    console.warn('[TTS] StreamElements failed:', e.message);
  }

  return null;
}

function detectLanguageForTTS(text) {
  const t = text.toLowerCase();
  const swahiliWords = ['jambo', 'habari', 'mambo', 'asante', 'niko', 'wewe', 'nina', 'sasa', 'bado', 'sana', 'kidogo', 'shule', 'kcse', 'exam', 'mtihani'];
  let swCount = 0;
  for (const w of swahiliWords) {
    if (t.includes(w)) swCount++;
  }
  if (swCount >= 2) return 'sw'; // Swahili
  return 'en'; // English
}

// ============ CONVERSATION MEMORY ============

const conversations = new Map();

function addToConversation(phoneNumber, role, content) {
  if (!conversations.has(phoneNumber)) conversations.set(phoneNumber, []);
  const history = conversations.get(phoneNumber);
  history.push({ role, content });
  if (history.length > 10) history.shift();
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
    browser: Browsers.appropriate('Chrome'),
    defaultQueryTimeoutMs: 60000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[BOT] Connection closed (${statusCode}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot().catch(e => console.error('[BOT] Reconnect failed:', e.message)), 3000);
      } else {
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
      console.log(`║  🤖 AI: ${AI_PROVIDER} • Bot: ${botActive ? '🟢 ACTIVE' : '🔴 OFF'}${' '.repeat(11)}║`);
      console.log(`║  🎤 Voice: ON (STT + TTS)${' '.repeat(17)}║`);
      console.log(`╚══════════════════════════════════════════════╝\n`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      // Skip groups + status broadcasts
      if (msg.key.remoteJid.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const senderJid = msg.key.participant || msg.key.remoteJid;
      const senderNum = senderJid.split('@')[0].split(':')[0];
      const senderName = msg.pushName || senderNum;

      // === Extract text OR detect voice note ===
      let text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption ||
                 msg.message?.videoMessage?.caption || '';

      const isVoiceNote = msg.message?.audioMessage || msg.message?.pttMessage;

      if (!text && !isVoiceNote) continue;

      // === .active command ===
      if (text.toLowerCase().trim() === '.active') {
        botActive = !botActive;
        try {
          await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
          await new Promise(r => setTimeout(r, 800));
          await sock.sendMessage(msg.key.remoteJid, {
            text: botActive
              ? `🟢 *AUTO-REPLY ACTIVATED*\n\nHey! ${OWNER_NAME} here. ${OWNER_STATUS}\n\nI'll be replying to messages now — text or voice! 😊🎤`
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

🤖 *AI:* ${AI_PROVIDER.toUpperCase()} (${AI_API_KEY ? '✅ Connected' : '⚠️ Local mode'})
🎤 *Voice:* ON (listens + replies with voice)
👤 *Owner:* ${OWNER_NAME}
📚 *Status:* ${OWNER_STATUS}
🟢 *Bot:* ${botActive ? 'ACTIVE' : 'OFF'}

📝 *Commands:*
  .active → Toggle auto-reply
  .menu   → Show this menu

_Send text OR voice notes!_`,
          }, { quoted: msg });
          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
        } catch (e) {}
        continue;
      }

      // === Auto-reply (only if active) ===
      if (!botActive) continue;

      try {
        // ★ Show typing indicator
        await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

        // ★ Handle voice notes
        if (isVoiceNote && !text) {
          console.log(`[VOICE] From ${senderName}: voice note received`);

          // Download the voice note
          let audioBuffer = null;
          try {
            const stream = await downloadMediaMessage(msg);
            if (stream) {
              audioBuffer = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
            }
          } catch (e) {
            console.warn('[VOICE] Download failed:', e.message);
          }

          // Transcribe to text
          let transcribedText = '[voice message]';
          if (audioBuffer) {
            transcribedText = await transcribeVoiceNote(audioBuffer);
            console.log(`[STT] Transcribed: "${transcribedText.slice(0, 60)}"`);
          }

          text = transcribedText;
        }

        console.log(`[MSG] From ${senderName}: "${(text || '').slice(0, 60)}"`);

        // ★ Generate AI reply
        const history = conversations.get(senderNum) || [];
        const reply = await generateAIReply(senderName, text, history);

        addToConversation(senderNum, 'user', text);
        addToConversation(senderNum, 'assistant', reply);

        // ★ Human-like delay
        const delay = Math.min(3000, Math.max(1000, reply.length * 30));
        await new Promise(r => setTimeout(r, delay));

        // ★ Reply with BOTH text AND voice note
        // Send text first
        await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: msg });
        console.log(`[REPLY] Text: "${reply.slice(0, 60)}"`);

        // Then generate + send voice note
        const audioBuffer = await generateVoiceNote(reply);
        if (audioBuffer) {
          await sock.sendMessage(msg.key.remoteJid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: true, // ★ Send as voice note (not regular audio)
          }, { quoted: msg });
          console.log(`[REPLY] Voice note sent (${audioBuffer.length} bytes)`);
        }

        await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
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
  return await sock.requestPairingCode(phoneNumber);
}

// ============ API ENDPOINTS ============

app.get('/health', (req, res) => {
  res.json({
    ok: true, bot: BOT_NAME,
    connected: connectionState.connected,
    active: botActive,
    ai: AI_PROVIDER,
    aiConnected: !!AI_API_KEY,
    voiceEnabled: true,
    number: connectionState.number || null,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    botName: BOT_NAME, version: '2.0.0',
    connected: connectionState.connected, active: botActive,
    owner: OWNER_NAME, ownerStatus: OWNER_STATUS,
    ai: AI_PROVIDER, aiConnected: !!AI_API_KEY,
    voiceEnabled: true,
    number: connectionState.number || null,
    name: connectionState.user?.name || null,
  });
});

app.post('/api/pair', async (req, res) => {
  try {
    const phoneNumber = (req.body?.phoneNumber || '').replace(/\D/g, '');
    if (!phoneNumber || !/^\d{8,15}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phone number. Use digits with country code.' });
    }
    if (connectionState.connected) {
      return res.status(409).json({ error: 'Already paired. Bot is connected.' });
    }
    const code = await getPairingCode(phoneNumber);
    res.json({
      success: true, code, phoneNumber, expiresIn: 90,
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
  res.json({ ok: true, active: true });
});

app.post('/api/deactivate', (req, res) => {
  botActive = false;
  res.json({ ok: true, active: false });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============

async function start() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║  ${BOT_NAME} v2.0                              ║`);
    console.log(`║  ★ ${AI_PROVIDER.toUpperCase()} AI + Voice Notes + Baileys        ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
    console.log(`\n🌐 Pairing: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/status`);
    console.log(`🤖 AI: ${AI_PROVIDER} (${AI_API_KEY ? '✅ Connected' : '⚠️ Local mode'})`);
    console.log(`🎤 Voice: STT (listen) + TTS (reply with voice)\n`);
  });

  try { await startBot(); } catch (e) { console.error('[FATAL]', e); }
  process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
  process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
}

start();
