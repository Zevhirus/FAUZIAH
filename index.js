import 'dotenv/config';
import fs from 'node:fs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 6);
const ALLOWED = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY belum diisi di .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const KB = fs.readFileSync(new URL('./kb.md', import.meta.url), 'utf8');

// MENU-START
// Label singkat untuk menu (kunci = nomor section di kb.md). Kalau kosong, pakai judul section.
const SHORT = {
  1: 'Pendaftaran perusahaan (Badan Usaha) baru',
  2: 'Lupa password Edabu',
  3: 'Daftarkan pekerja yang belum pernah terdaftar BPJS',
  4: 'Pindahkan pekerja dari segmen lain (PBI/PBPU Mandiri/Pemda) ke Badan Usaha',
  5: 'Tambah anggota keluarga yang belum pernah terdaftar',
  6: 'Tambah anggota keluarga yang sudah pernah terdaftar',
  7: 'Update gaji (satu pekerja)',
  8: 'Update gaji masal (banyak pekerja)',
  9: 'Ganti faskes tingkat pertama',
  10: 'Nonaktifkan pekerja',
  11: 'Cetak kartu peserta dari Edabu',
  12: 'Pengajuan cetak sertifikat BPJS Kesehatan',
  13: 'Tutup Badan Usaha',
  14: 'Batas waktu tambah/nonaktif pekerja',
  15: 'Panduan layanan dan flyer edukasi',
  16: 'Kode faskes tingkat pertama',
};

// Pecah kb.md per "## N. Judul"
const SECTIONS = {};
for (const block of KB.split(/^## /m).slice(1)) {
  const [head, ...rest] = block.split('\n');
  const m = head.match(/^(\d+)\.\s+(.*)$/);
  if (!m) continue;
  SECTIONS[Number(m[1])] = { title: m[2].trim(), body: rest.join('\n').trim() };
}
const NUMS = Object.keys(SECTIONS).map(Number).sort((a, b) => a - b);

const MENU_TEXT =
  '*Layanan Edabu BPJS Kesehatan (Badan Usaha)*\n' +
  'Balas dengan *nomor* pertanyaan:\n\n' +
  NUMS.map((n) => `${n}. ${SHORT[n] || SECTIONS[n].title}`).join('\n') +
  '\n\nAtau tulis pertanyaanmu langsung, nanti dijawab asisten AI.';

const MENU_FOOTER =
  '\n\n_Ketik *menu* untuk melihat daftar lagi, atau tulis pertanyaanmu sendiri._';

const MENU_TRIGGER =
  /^(menu|0|halo|hallo|hai|hi|hello|p|start|mulai|assalamualaikum|selamat (pagi|siang|sore|malam))[!. ]*$/i;
// MENU-END

const SYSTEM_PROMPT = `Kamu adalah asisten virtual layanan Edabu BPJS Kesehatan untuk Badan Usaha (HRD/admin perusahaan).
Jawab HANYA berdasarkan KNOWLEDGE BASE di bawah. Gunakan Bahasa Indonesia yang ramah, singkat, dan jelas.
Aturan:
- Format untuk WhatsApp: boleh pakai *tebal* dan daftar bernomor, tanpa tabel dan tanpa heading markdown (#).
- Jika jawabannya ada di knowledge base, berikan langkah-langkah yang runut.
- Jika tidak ada di knowledge base, jangan mengarang. Katakan belum punya informasinya dan arahkan ke Call Center BPJS Kesehatan 165 atau Relationship Officer (RO) perusahaan.
- Jangan meminta atau menyimpan data pribadi sensitif (NIK, password, nomor kartu) lewat chat. Jika pengguna mengirimnya, ingatkan agar tidak membagikannya.
- Kamu bukan layanan resmi BPJS Kesehatan. Untuk keputusan resmi, tetap rujuk ke BPJS Kesehatan.
- Jika pertanyaan tidak terkait BPJS Kesehatan / Edabu, tolak dengan sopan.

KNOWLEDGE BASE:
${KB}`;

// Memori percakapan sederhana per nomor (in-memory)
const history = new Map(); // jid -> [{role, parts:[{text}]}]
const MAX_TURNS = 6;

// Rate limit sederhana
const hits = new Map(); // jid -> [timestamps]
function limited(jid) {
  const now = Date.now();
  const arr = (hits.get(jid) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(jid, arr);
  return arr.length > RATE_LIMIT;
}

async function askGemini(jid, text) {
  const past = history.get(jid) || [];
  const contents = [...past, { role: 'user', parts: [{ text }] }];

  const res = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  });

  const answer =
    (res.text || '').trim() ||
    'Maaf, aku belum bisa menjawab itu. Silakan hubungi Call Center BPJS Kesehatan 165.';

  const updated = [...contents, { role: 'model', parts: [{ text: answer }] }];
  history.set(jid, updated.slice(-MAX_TURNS * 2));
  return answer;
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Edabu Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Scan QR ini lewat WhatsApp > Perangkat tertaut:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('Bot tersambung.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[koneksi] ditutup, kode:', code, lastDisconnect?.error?.message || '');
      if (code === DisconnectReason.loggedOut) {
        console.log('Sesi logout. Hapus folder "auth" lalu jalankan ulang untuk scan QR baru.');
      } else {
        console.log('Koneksi terputus, mencoba sambung lagi...');
        start();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[upsert] type=${type} jumlah=${messages.length}`);
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) {
          console.log('[skip] pesan dari akun bot sendiri (fromMe). Chat dari HP lain, bukan dari nomor bot.');
          continue;
        }
        const jid = msg.key.remoteJid;
        // Hanya chat pribadi. WhatsApp kini sering memakai @lid selain @s.whatsapp.net.
        const isPrivate = jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
        if (!isPrivate) {
          console.log('[skip] bukan chat pribadi:', jid);
          continue;
        }

        // Nomor asli (kalau tersedia) untuk ALLOWED_NUMBERS
        const realJid = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJidAlt || jid;
        const number = realJid.split('@')[0];
        if (ALLOWED.length && !ALLOWED.includes(number)) {
          console.log('[skip] nomor tidak ada di ALLOWED_NUMBERS:', number, '(jid:', jid + ')');
          continue;
        }

        const text = extractText(msg);
        console.log(`[masuk] ${jid} (${number}): ${text || '(bukan teks)'}`);
        if (!text) {
          await sock.sendMessage(jid, { text: 'Maaf, aku baru bisa membaca pesan teks ya.' });
          continue;
        }

        if (limited(jid)) {
          await sock.sendMessage(jid, { text: 'Pelan-pelan ya, coba lagi sebentar lagi.' });
          continue;
        }

        if (/^\/?(reset|mulai ulang)$/i.test(text)) {
          history.delete(jid);
          await sock.sendMessage(jid, { text: 'Percakapan direset. Silakan tanya lagi.' });
          continue;
        }

        // Menu bernomor: "menu"/sapaan -> daftar; angka -> jawaban dari kb.md (tanpa Gemini)
        if (MENU_TRIGGER.test(text.trim())) {
          await sock.sendMessage(jid, { text: MENU_TEXT });
          continue;
        }
        if (/^\d{1,2}[.)]?$/.test(text.trim())) {
          const n = parseInt(text, 10);
          if (SECTIONS[n]) {
            const s = SECTIONS[n];
            await sock.sendMessage(jid, { text: `*${s.title}*\n\n${s.body}${MENU_FOOTER}` });
          } else {
            await sock.sendMessage(jid, { text: `Nomor ${n} tidak ada di daftar.\n\n${MENU_TEXT}` });
          }
          continue;
        }

        await sock.readMessages([msg.key]);
        await sock.sendPresenceUpdate('composing', jid);

        const answer = await askGemini(jid, text);

        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: answer }, { quoted: msg });
      } catch (err) {
        console.error('[error] gagal memproses pesan:', err?.status || '', err?.message || err);
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: 'Maaf, sistem sedang bermasalah. Coba lagi sebentar lagi atau hubungi Call Center BPJS Kesehatan 165.',
          });
        } catch (e2) {
          console.error('[error] gagal kirim pesan fallback:', e2?.message || e2);
        }
      }
    }
  });
}

start();
