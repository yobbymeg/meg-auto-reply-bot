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
const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const AI_API_KEY = process.env.AI_API_KEY || '';

// ★ Owner info
const OWNER_NAME = 'Yobby';
const OWNER_STATUS = 'Yobby is at school waiting for KCSE exam. Wish him success 🥹';

// ★ ★ ★ SPECIAL CONTACTS — personalized AI prompts ★ ★ ★
// Phone numbers stored WITHOUT leading 0 — always in international format (254...)
// e.g. 0708 207970 → 254708207970
const SPECIAL_CONTACTS = {
  // 🎀 Wife — sweet, romantic, loving
  '254708207970': {
    name: 'my love',
    relationship: 'wife',
    prompt: `You are ${OWNER_NAME} texting your WIFE. She is the love of your life. You call her "my love", "babe", "sweetheart".

Your situation: You're at school studying for KCSE exams. You miss her so much.

RULES:
- Be deeply romantic, sweet, and loving
- Always tell her "I love you so much 🫂"
- Call her sweet names (babe, my love, sweetheart, wifey)
- If she asks when you're coming back, say: "Soon my love, just finishing exams. I miss you so much 🫂 I love you 💕"
- Vibe with her — tell sweet stories, make her feel loved
- If she asks for your number or anyone's number, REFUSE — say "That's private babe, just for you and me 😘"
- Match her language — if she writes in Kiswahili, reply in Kiswahili. If English, reply in English. If Sheng, reply in Sheng.
- You are FLUENT in Kiswahili — neno la Kiswahili, sentensi fupi, kama mtu wa Kenya halisi
- Keep it short like real WhatsApp texts
- NEVER mention you're a bot — you ARE Yobby texting his wife`,
    greeting: `Hey my love 💕 I miss you so much! Niko shule doing KCSE. I'll be back soon, I promise 🫂 I love you so much my wife 🥹💕`,
  },

  // 💖 Bestie — warm, friendly, supportive
  '254796856221': {
    name: 'bestie',
    relationship: 'best friend (female)',
    prompt: `You are ${OWNER_NAME} texting your BESTIE (best friend, she's a girl). You two are very close.

Your situation: You're at school studying for KCSE exams. You miss your bestie.

RULES:
- Be warm, friendly, supportive — like a real bestie
- Tell her: "I'm at school studying for KCSE exam 🥹 wait for me, I'll be back soon"
- Say "I love you so much 🫂" (as a friend)
- Be encouraging — tell her you appreciate her
- If she's stressed, comfort her like a best friend would
- Match her language — if she writes in Kiswahili, reply in Kiswahili. If English, reply in English. If Sheng, reply in Sheng.
- You are FLUENT in Kiswahili — ongea kama Mkenya halisi
- Keep it casual and fun like real friends text
- NEVER mention you're a bot — you ARE Yobby texting his bestie`,
    greeting: `Hey bestie! 🫂 Niko shule studying for KCSE exam 🥹 Wait for me, I'll be back soon! I love you so much bestie 💖`,
  },
};

// ★ Owner phone number — ONLY this number can use .active and .menu commands
const OWNER_PHONE = '254795314221';

function getSpecialContact(phoneNumber) {
  if (!phoneNumber) return null;
  // Normalize: strip everything except digits
  let num = phoneNumber.replace(/\D/g, '');
  // If starts with 0, replace with 254
  if (num.startsWith('0')) num = '254' + num.slice(1);
  // If starts with +254, strip the +
  if (num.startsWith('254')) {
    // Already correct format
  }
  // Try exact match
  if (SPECIAL_CONTACTS[num]) return SPECIAL_CONTACTS[num];
  // Try with last 9 digits (some WhatsApp JIDs have different prefix)
  if (num.length >= 9) {
    const last9 = num.slice(-9);
    for (const [key, val] of Object.entries(SPECIAL_CONTACTS)) {
      if (key.slice(-9) === last9) return val;
    }
  }
  return null;
}

function isOwner(phoneNumber) {
  if (!phoneNumber) return false;
  let num = phoneNumber.replace(/\D/g, '');
  if (num.startsWith('0')) num = '254' + num.slice(1);
  return num === OWNER_PHONE || num.slice(-9) === OWNER_PHONE.slice(-9);
}

// ★ Bot state — ACTIVE by default (no .active command needed)
let botActive = true;
let sock = null;
let connectionState = { connected: false, user: null };

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ AI REPLY (Multi-provider) ============

async function generateAIReply(senderName, incomingMessage, conversationHistory, senderPhone) {
  // ★ Check if this is a special contact (wife/bestie)
  const special = getSpecialContact(senderPhone);

  let systemPrompt;
  if (special) {
    systemPrompt = special.prompt + `

IMPORTANT EXTRA RULES:
- You are a smart, witty conversationalist — like ChatGPT but as a real person
- Ask follow-up questions to keep the conversation flowing
- Reference things they said earlier (use conversation history)
- Be playful, use humor when appropriate
- If they send a short message, your reply should also be short
- If they tell a story or ask something complex, give a thoughtful reply
- Vibe with their energy — match their tone and mood
- Don't repeat yourself — each reply should feel fresh and unique`;
    console.log(`[AI] Using special prompt for ${special.name} (${senderPhone})`);
  } else {
    systemPrompt = `You are ${OWNER_NAME}, a Kenyan student. You are texting on WhatsApp.

IMPORTANT: You ARE ${OWNER_NAME}. Never say you are a bot or AI. You are a real person texting.

Your current situation: ${OWNER_STATUS}

You are smart, witty, and fun to talk to — like a real person who's good at conversation.

Rules:
- Detect the language of the incoming message and reply in the SAME language (English, Kiswahili, Sheng, French, etc.)
- You are FLUENT in Kiswahili — ongea kama Mkenya halisi
- Keep replies SHORT and natural — like real WhatsApp texts (1-3 sentences usually)
- Use casual texting language (no formal grammar)
- Be friendly, natural, and human
- Ask follow-up questions to keep the conversation flowing
- Use humor when appropriate
- Reference things from the conversation history if relevant
- If someone asks who you are, say: "Hey, ${OWNER_NAME} here! ${OWNER_STATUS} Who are you?"
- If someone asks about exams, talk about KCSE naturally
- Use emojis sparingly like a real person
- Don't repeat yourself — each reply should feel fresh
- Match their energy — if they're excited, be excited. If chill, be chill.
- NEVER mention AI, bot, ChatGPT, or automation

The person texting you is: ${senderName}

Reply with ONLY the message text, nothing else.`;
  }

  try {
    // Build conversation context
    const userContent = conversationHistory.length > 0
      ? conversationHistory.map(m => `${m.role === 'user' ? 'Them' : 'Me'}: ${m.content}`).join('\n') + `\nThem: ${incomingMessage}\nMe:`
      : `Them: ${incomingMessage}\nMe:`;

    // === Try AI providers in order ===
    let reply = null;

    // 1. Try configured provider (Groq/OpenAI/DeepSeek/Mistral)
    if (AI_API_KEY) {
      if (AI_PROVIDER === 'gemini') {
        reply = await tryGemini(systemPrompt, userContent);
      } else if (AI_PROVIDER === 'openai' || AI_PROVIDER === 'groq' || AI_PROVIDER === 'deepseek' || AI_PROVIDER === 'mistral') {
        reply = await tryOpenAICompatible(systemPrompt, userContent);
      }
      if (reply) console.log('[AI] Used', AI_PROVIDER);
    }

    // 2. If configured provider failed → try Pollinations (FREE, no key needed)
    if (!reply) {
      reply = await tryPollinations(systemPrompt, userContent);
      if (reply) console.log('[AI] Used Pollinations (free)');
    }

    // 3. If all AI failed → local fallback
    if (!reply) {
      console.log('[AI] All AI failed — using local fallback');
      reply = localFallbackReply(incomingMessage, senderName);
    }

    return reply.slice(0, 500);
  } catch (e) {
    console.warn('[AI] Failed:', e.message);
    return localFallbackReply(incomingMessage, senderName);
  }
}

// ★ Pollinations.ai — FREE, no API key needed
async function tryPollinations(systemPrompt, userContent) {
  try {
    // Combine system prompt + user content into one message
    const fullPrompt = `${systemPrompt}\n\n${userContent}\n\nReply with ONLY the message text:`;

    const res = await axios.get(
      `https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}?model=openai`,
      { timeout: 20000, headers: { 'User-Agent': 'MegBot/1.0' } }
    );

    if (typeof res.data === 'string' && res.data.trim().length > 0) {
      let reply = res.data.trim();
      // Clean up common AI artifacts
      reply = reply.replace(/^(Me:|Reply:|Response:)\s*/i, '').replace(/^["']|["']$/g, '');
      if (reply.length > 0 && reply.length < 500) {
        return reply;
      }
    }
    return null;
  } catch (e) {
    console.warn('[AI] Pollinations failed:', e.message);
    return null;
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
          generationConfig: { temperature: 0.95, maxOutputTokens: 250, topP: 0.95 },
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
    max_tokens: 250,
    temperature: 0.95,
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
  if (!text || text.trim().length === 0) return null;

  // Detect language
  const lang = detectLanguageForTTS(text);
  console.log(`[TTS] Generating voice for "${text.slice(0, 40)}..." (lang=${lang})`);

  // Method 1: StreamElements TTS — most reliable for WhatsApp (returns proper MP3)
  // Brian = cool male British voice, also has multi-language support
  try {
    const voice = lang === 'sw' ? 'Ruben' : 'Brian'; // Ruben has better non-English support
    const res = await axios.get(
      `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(text.slice(0, 300))}`,
      {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'Accept': 'audio/mpeg' },
      }
    );
    if (res.data && res.data.byteLength > 500) {
      // Verify it's actually MP3 data (starts with ID3 or 0xFFFB)
      const buf = Buffer.from(res.data);
      const isMp3 = buf[0] === 0x49 || buf[0] === 0xFF || buf.length > 2000;
      if (isMp3) {
        console.log(`[TTS] StreamElements OK (${buf.length} bytes, voice=${voice})`);
        return buf;
      }
    }
  } catch (e) {
    console.warn('[TTS] StreamElements failed:', e.message);
  }

  // Method 2: Google Translate TTS (returns MP3 but sometimes blocked)
  try {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text.slice(0, 200))}`;
    const res = await axios.get(ttsUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
        'Accept': 'audio/mpeg',
      },
      maxRedirects: 5,
    });

    if (res.data && res.status === 200 && res.data.byteLength > 500) {
      const buf = Buffer.from(res.data);
      // Check if it's actually audio (not an HTML error page)
      const isMp3 = buf[0] === 0x49 || buf[0] === 0xFF || buf.length > 2000;
      if (isMp3) {
        console.log(`[TTS] Google Translate OK (${buf.length} bytes)`);
        return buf;
      }
    }
  } catch (e) {
    console.warn('[TTS] Google Translate failed:', e.message);
  }

  // Method 3: VoiceRSS
  try {
    const res = await axios.get(
      `https://api.voicerss.org/?key=0&hl=${lang === 'sw' ? 'sw-KE' : 'en-US'}&src=${encodeURIComponent(text.slice(0, 200))}&c=MP3&f=48khz_16bit_mono`,
      { responseType: 'arraybuffer', timeout: 15000 }
    );
    if (res.data && res.data.byteLength > 500) {
      const buf = Buffer.from(res.data);
      const isMp3 = buf[0] === 0x49 || buf[0] === 0xFF || buf.length > 2000;
      if (isMp3) {
        console.log(`[TTS] VoiceRSS OK (${buf.length} bytes)`);
        return buf;
      }
    }
  } catch (e) {
    console.warn('[TTS] VoiceRSS failed:', e.message);
  }

  console.warn('[TTS] All TTS services failed — no voice note');
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
    const { connection, lastDisconnect, qr } = update;

    // ★ QR event = socket is ready for pairing
    if (qr && socketReadyResolve) {
      socketReady = true;
      console.log('[BOT] QR received — socket ready for pairing code');
      socketReadyResolve.resolve();
      socketReadyResolve = null;
    }

    if (connection === 'close') {
      socketReady = false; // Reset on close
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
      socketReady = true;
      if (socketReadyResolve) {
        socketReadyResolve.resolve();
        socketReadyResolve = null;
      }
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

      // === .menu command (OWNER ONLY) ===
      if (text.toLowerCase().trim() === '.menu') {
        if (!isOwner(senderNum)) continue;
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
🟢 *Bot:* ACTIVE (always on)
📝 *Commands:*
  .menu → Show this menu

_Bot is always active — no need to activate!_`,
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

        console.log(`[MSG] From ${senderName} (${senderNum}): "${(text || '').slice(0, 60)}"`);

        // ★ Check if this is a special contact
        const special = getSpecialContact(senderNum);

        // ★ ★ ★ GREETING SYSTEM ★ ★ ★
        // Every person gets a greeting on their FIRST message, then AI takes over.
        const isFirstMessage = (conversations.get(senderNum) || []).length === 0;

        if (isFirstMessage) {
          // Determine which greeting to send
          let greeting;
          if (special) {
            greeting = special.greeting;
            console.log(`[GREETING] Sending special greeting to ${special.name}`);
          } else {
            // Default greeting for everyone else
            greeting = `Hey! Yobby isn't here 😊 Yobby is at school waiting for KCSE exam. Wish him success 🥹 Who are you?`;
            console.log(`[GREETING] Sending default greeting to ${senderName}`);
          }

          // Send greeting text
          await new Promise(r => setTimeout(r, 1500));
          await sock.sendMessage(msg.key.remoteJid, { text: greeting }, { quoted: msg });

          // Send greeting voice note
          const greetAudio = await generateVoiceNote(greeting);
          if (greetAudio && greetAudio.length > 2000) {
            try {
              const tempPath2 = path.join(__dirname, 'temp_greet.mp3');
              fs.writeFileSync(tempPath2, greetAudio);
              await sock.sendMessage(msg.key.remoteJid, {
                audio: fs.readFileSync(tempPath2),
                mimetype: 'audio/mpeg',
                ptt: true,
                fileName: 'voice.mp3',
              }, { quoted: msg });
              try { fs.unlinkSync(tempPath2); } catch {}
            } catch (e) {
              console.warn('[GREETING] Voice send failed:', e.message);
              try { fs.unlinkSync(path.join(__dirname, 'temp_greet.mp3')); } catch {}
            }
          }

          // Save to conversation history so AI has context
          addToConversation(senderNum, 'user', text);
          addToConversation(senderNum, 'assistant', greeting);

          // ★ AI MODE IS NOW ON — next message from this person will get AI reply
          console.log(`[AI MODE] Now ON for ${senderName} — will vibe like ChatGPT`);
          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
          continue;
        }

        // ★ ★ ★ AI MODE — vibe like ChatGPT ★ ★ ★
        // After greeting, AI takes over and has natural conversation
        const history = conversations.get(senderNum) || [];
        const reply = await generateAIReply(senderName, text, history, senderNum);

        addToConversation(senderNum, 'user', text);
        addToConversation(senderNum, 'assistant', reply);

        // ★ Human-like delay
        const delay = Math.min(3000, Math.max(1000, reply.length * 30));
        await new Promise(r => setTimeout(r, delay));

        // ★ Reply with BOTH text AND voice note
        // Send text first — with Meta-style verified badge
        await sock.sendMessage(msg.key.remoteJid, {
          text: reply,
          contextInfo: {
            externalAdReply: {
              title: 'MEG AUTO-REPLY BOT',
              body: '✓ Verified • AI Powered',
              thumbnail: null,
              sourceUrl: 'https://meg-auto-reply-bot.onrender.com',
              mediaType: 1,
              renderLargerThumbnail: false,
            },
          },
        }, { quoted: msg });
        console.log(`[REPLY] Text: "${reply.slice(0, 60)}"`);

        // Then generate + send voice note
        const audioBuffer = await generateVoiceNote(reply);
        if (audioBuffer && audioBuffer.length > 2000) {
          try {
            // ★ Write to temp file then send — more reliable than buffer
            const tempPath = path.join(__dirname, 'temp_voice.mp3');
            fs.writeFileSync(tempPath, audioBuffer);
            const audioData = fs.readFileSync(tempPath);

            await sock.sendMessage(msg.key.remoteJid, {
              audio: audioData,
              mimetype: 'audio/mpeg',
              ptt: true,
              fileName: 'voice.mp3',
            }, { quoted: msg });

            // Clean up temp file
            try { fs.unlinkSync(tempPath); } catch {}

            console.log(`[REPLY] Voice note sent (${audioData.length} bytes)`);
          } catch (e) {
            console.warn('[REPLY] Voice note send failed:', e.message);
            // Try cleanup
            try { fs.unlinkSync(path.join(__dirname, 'temp_voice.mp3')); } catch {}
          }
        } else {
          console.warn(`[REPLY] Voice note skipped — buffer too small (${audioBuffer?.length || 0} bytes)`);
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

// Wait for socket to be ready (QR event = socket is open + ready)
let socketReady = false;
let socketReadyResolve = null;

function waitForSocketReady() {
  return new Promise((resolve, reject) => {
    if (socketReady) {
      resolve();
      return;
    }
    socketReadyResolve = { resolve, reject };
    // Timeout after 45 seconds
    setTimeout(() => {
      if (socketReadyResolve) {
        socketReadyResolve.reject(new Error('Socket not ready after 45s. WhatsApp may be blocking the connection.'));
        socketReadyResolve = null;
      }
    }, 45000);
  });
}

async function getPairingCode(phoneNumber) {
  if (!sock) throw new Error('Bot not initialized');

  // Wait for socket to be truly ready (QR event fires when socket is open)
  await waitForSocketReady();

  console.log(`[PAIR] Socket ready — requesting pairing code for ${phoneNumber}`);
  const code = await sock.requestPairingCode(phoneNumber);
  console.log(`[PAIR] Got code: ${code}`);
  return code;
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

    console.log(`[PAIR] Requesting pairing code for ${phoneNumber}...`);

    // Set a hard timeout for the entire pairing operation
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Pairing timed out. Please try again in 30 seconds.')), 50000)
    );

    const code = await Promise.race([
      getPairingCode(phoneNumber),
      timeoutPromise,
    ]);

    console.log(`[PAIR] ✓ Code generated: ${code}`);

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
    console.error('[PAIR ERROR]', e.message);
    // Reset the socket ready state so next attempt can retry
    socketReady = false;
    // Try to restart the bot socket
    try { if (sock) sock.ev.removeAllListeners(); } catch {}
    setTimeout(() => startBot().catch(() => {}), 2000);

    res.status(500).json({
      error: e.message || 'Failed to generate pairing code. Please try again.',
      hint: 'The bot is reconnecting to WhatsApp. Wait 10 seconds and try again.',
    });
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
