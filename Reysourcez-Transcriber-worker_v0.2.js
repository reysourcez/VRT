/* ============================================================
   Reysourcez Voice Transcriber - Worker (API)
   VERSION 0.2 | file: Reysourcez-Transcriber-worker_v0.2.js | 2026-10-08
   ------------------------------------------------------------
   What this does
   - Receives audio from the web page, sends it to a speech engine
     (Gemini 3.5 Transcribe and/or Whisper on Workers AI), saves text,
     corrections, word list (lexicon) and usage in the D1 database.
   - Enforces: access code, consent, per-device daily minutes, monthly cost cap.
   - Keeps every key and rule here. Nothing secret is ever sent to the page.
   Setup: see the Dossier, section "Deploy guide".
   Bindings : DB (D1, required) | AI (Workers AI, for Whisper/Tamil) | AUDIO (R2, optional)
   Secrets  : ACCESS_CODE (required) | GEMINI_API_KEY | ADMIN_CODE (optional)
   Variables: every key in DEFAULTS below can be overridden in Cloudflare.
   Notes    : ref rev2.a = first build. Engine formats checked against the docs on 2026-10-08.
   ============================================================ */

const VERSION = '0.2';
const BUILD_DATE = '2026-10-08';
const SCHEMA_VERSION = 1;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/* ---------- 1. Settings (all optional; set as Variables in Cloudflare) ---------- */
const DEFAULTS = {
  ALLOWED_ORIGINS: 'https://www.reysourcez.com,https://reysourcez.com', // pages allowed to call this Worker
  GEMINI_ENABLED: '0',            // set to 1 only AFTER billing is on for the Gemini project
  GEMINI_MODEL: 'gemini-3.5-transcribe',
  WHISPER_MODEL: '@cf/openai/whisper-large-v3-turbo',
  WHISPER_VAD: '1',               // 1 = skip silence before transcribing
  MONTHLY_CAP_USD: '5',           // whole-site spending cap (estimate)
  DAILY_MIN_PER_CLIENT: '120',    // audio minutes per device per day
  MAX_UPLOAD_MB: '20',            // one audio part
  MAX_SEGMENT_SEC: '1800',        // longest single part (30 min)
  RETENTION_DAYS: '90',           // kept audio is deleted after this (needs the daily Cron Trigger)
  CONSENT_VERSION: '2026-10-v1',  // change when the consent wording changes; must match the page
  RULE_MIN_SEEN: '3',             // identical corrections before a fix is suggested
  BIAS_TERMS_MAX: '100',          // word-list terms sent with each request
  COST_GEMINI_PER_MIN_USD: '0.005',   // estimate, see Dossier 4.8
  COST_WHISPER_PER_MIN_USD: '0.00051' // Cloudflare list price per audio minute
};

/* ---------- 2. Languages (single source of truth; the page reads these from /api/config) ---------- */
const LANGS = {
  auto:         { id: 'auto',       label: 'Auto-detect (mixed speech)', gemini: [],                whisper: null, lexicons: ['ms', 'ms-sarawak', 'en'], engine: 'gemini',  status: 'ready' },
  ms:           { id: 'ms',         label: 'Bahasa Malaysia',            gemini: ['ms-MY'],         whisper: 'ms', lexicons: ['ms'],                     engine: 'gemini',  status: 'ready' },
  'ms-sarawak': { id: 'ms-sarawak', label: 'Bahasa Sarawak',             gemini: ['ms-MY'],         whisper: 'ms', lexicons: ['ms-sarawak', 'ms'],       engine: 'gemini',  status: 'beta' },
  en:           { id: 'en',         label: 'English',                    gemini: ['en-GB'],         whisper: 'en', lexicons: ['en'],                     engine: 'gemini',  status: 'ready' },
  'ms-en':      { id: 'ms-en',      label: 'BM + English mixed',         gemini: ['ms-MY', 'en-GB'], whisper: 'ms', lexicons: ['ms', 'ms-sarawak', 'en'], engine: 'gemini',  status: 'ready' },
  zh:           { id: 'zh',         label: 'Mandarin',                   gemini: ['cmn-Hans-CN'],   whisper: 'zh', lexicons: ['zh'],                     engine: 'gemini',  status: 'secondary' },
  ta:           { id: 'ta',         label: 'Tamil',                      gemini: null,              whisper: 'ta', lexicons: ['ta'],                     engine: 'whisper', status: 'secondary' },
  iban:         { id: 'iban',       label: 'Iban (experimental)',        gemini: ['ms-MY'],         whisper: 'ms', lexicons: ['iban'],                   engine: 'gemini',  status: 'experimental' }
};
const LEX_KEYS = ['ms', 'ms-sarawak', 'en', 'zh', 'ta', 'iban'];
const SOURCES = ['mic', 'tab+mic', 'upload'];

/* ---------- 3. Small helpers ---------- */
class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function conf(env) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = env ? env[k] : undefined;
    out[k] = v === undefined || v === null || String(v).trim() === '' ? DEFAULTS[k] : String(v).trim();
  }
  return out;
}
function langOf(id) { return LANGS[id] || LANGS.auto; }
function nowIso() { return new Date().toISOString(); }
function dayStr(d) { return (d || new Date()).toISOString().slice(0, 10); }
function monthStart(d) { return (d || new Date()).toISOString().slice(0, 7) + '-01'; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function nul(v) { return v === undefined ? null : v; }
function cleanStr(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}
function isId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function logEvent(level, evt, data) {
  // Never log audio, transcripts or keys. IDs, sizes and timings only.
  try { console.log(JSON.stringify(Object.assign({ t: nowIso(), lvl: level, evt, v: VERSION }, data || {}))); } catch (e) { /* ignore */ }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = conf(env).ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-RZ-Access, X-RZ-Admin, X-RZ-Client',
    'Access-Control-Max-Age': '86400'
  };
  if (origin && (allowed.includes('*') || allowed.includes(origin))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  // Plain btoa in chunks: works without any compatibility flag.
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function normalizeMime(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase();
  return base || 'application/octet-stream';
}
const GEMINI_MIME = {
  'audio/webm': 'audio/webm', 'video/webm': 'audio/webm',
  'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a', 'audio/m4a': 'audio/m4a',
  'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mp3',
  'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/ogg': 'audio/ogg', 'audio/opus': 'audio/opus',
  'audio/flac': 'audio/flac', 'audio/x-flac': 'audio/flac',
  'audio/aac': 'audio/aac', 'audio/aiff': 'audio/aiff', 'audio/x-aiff': 'audio/aiff'
};
function geminiMime(base) { return GEMINI_MIME[base] || null; }
function extFor(base) {
  const g = geminiMime(base) || base;
  const map = { 'audio/webm': 'webm', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/aiff': 'aiff' };
  return map[g] || 'bin';
}

/* ---------- 4. Database: tables are created automatically on first use ---------- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT NOT NULL, title TEXT, language TEXT, source TEXT, keep_audio INTEGER NOT NULL DEFAULT 0, consent_version TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_recordings_client ON recordings(client_id, created_at)',
  'CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, idx INTEGER NOT NULL, created_at TEXT NOT NULL, duration_sec REAL, mime TEXT, bytes INTEGER, r2_key TEXT, text_raw TEXT, text_final TEXT, engine TEXT, lang_detected TEXT, UNIQUE(recording_id, idx))',
  'CREATE TABLE IF NOT EXISTS engine_runs (id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, engine TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER, est_cost_usd REAL, text TEXT, error TEXT, created_at TEXT NOT NULL, wer REAL, ref_words INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_runs_segment ON engine_runs(segment_id)',
  'CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, client_id TEXT NOT NULL, language TEXT, before_text TEXT, after_text TEXT, created_at TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS lexicon_terms (id TEXT PRIMARY KEY, language TEXT NOT NULL, term TEXT NOT NULL, meaning TEXT, variants TEXT, source TEXT, status TEXT NOT NULL DEFAULT 'unverified', created_at TEXT NOT NULL, created_by TEXT, UNIQUE(language, term))",
  'CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, language TEXT NOT NULL, wrong TEXT NOT NULL, right TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(language, wrong, right))',
  'CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, client_id TEXT NOT NULL, engine TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, client_id, engine))',
  'CREATE TABLE IF NOT EXISTS consent_log (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, version TEXT NOT NULL, granted INTEGER NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_consent_client ON consent_log(client_id, version, scope, created_at)',
  'CREATE TABLE IF NOT EXISTS auth_fail (ip_hash TEXT NOT NULL, hour TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, hour))',
  'CREATE TABLE IF NOT EXISTS error_log (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, route TEXT, code TEXT, message TEXT, detail TEXT)'
];

let schemaDb = null; // the database connection we already set up (remembered per Worker instance)
async function ensureSchema(env) {
  if (!env.DB) throw new HttpError(503, 'db_missing', 'The database is not connected. Add a D1 binding named DB (Deploy guide, step 5).');
  if (schemaDb === env.DB) return;
  const stmts = SCHEMA.map((s) => env.DB.prepare(s));
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").bind(String(SCHEMA_VERSION)));
  await env.DB.batch(stmts);
  schemaDb = env.DB;
}

async function logErrorRow(env, route, code, message, detail) {
  try {
    if (!env.DB) return null;
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO error_log(id, created_at, route, code, message, detail) VALUES(?,?,?,?,?,?)')
      .bind(id, nowIso(), cleanStr(route, 80), cleanStr(code, 60), cleanStr(message, 400), cleanStr(detail, 1500)).run();
    if (Math.random() < 0.05) {
      await env.DB.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY created_at DESC LIMIT 500)').run();
    }
    return id;
  } catch (e) { return null; }
}

/* ---------- 5. Access, consent, caps ---------- */
async function requireAuth(request, env) {
  if (!env.ACCESS_CODE) throw new HttpError(503, 'not_configured', 'ACCESS_CODE is not set. Add it as a Secret (Deploy guide, step 7).');
  await ensureSchema(env);
  const ipHash = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 32);
  const hour = nowIso().slice(0, 13);
  const row = await env.DB.prepare('SELECT n FROM auth_fail WHERE ip_hash=? AND hour=?').bind(ipHash, hour).first();
  if (row && row.n >= 20) throw new HttpError(429, 'too_many_attempts', 'Too many wrong access codes from this network. Try again in an hour.');
  const given = request.headers.get('X-RZ-Access') || '';
  if (!given || !timingSafeEqual(given, env.ACCESS_CODE)) {
    await env.DB.prepare('INSERT INTO auth_fail(ip_hash, hour, n) VALUES(?,?,1) ON CONFLICT(ip_hash, hour) DO UPDATE SET n = n + 1').bind(ipHash, hour).run();
    throw new HttpError(401, 'bad_access_code', 'The access code is missing or wrong. Enter it again in Setup.');
  }
  const clientId = request.headers.get('X-RZ-Client') || '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) throw new HttpError(400, 'bad_client', 'Missing device ID. Reload the page.');
  return { clientId };
}

function requireAdmin(request, env) {
  const need = env.ADMIN_CODE || env.ACCESS_CODE;
  const given = request.headers.get('X-RZ-Admin') || '';
  if (!given || !timingSafeEqual(given, need)) {
    throw new HttpError(403, 'admin_required', 'This needs the admin code. Enter it in Setup (leave blank if you have only one code).');
  }
}

async function getConsent(env, clientId, version) {
  const r = await env.DB.prepare('SELECT scope, granted FROM consent_log WHERE client_id=? AND version=? ORDER BY created_at DESC, rowid DESC').bind(clientId, version).all();
  const out = { processing: false, participants: false, keep_audio: false, recorded: false };
  const seen = {};
  for (const row of (r.results || [])) {
    if (seen[row.scope]) continue;
    seen[row.scope] = true;
    out.recorded = true;
    if (row.scope in out) out[row.scope] = row.granted === 1;
  }
  return out;
}

// Pure: decides whether a request fits under the caps.
function checkCaps(o) {
  if (o.monthCostUsd + o.addCostUsd > o.capUsd) {
    return { ok: false, code: 'monthly_cap', message: 'The monthly spending cap (about US$' + o.capUsd + ') is reached. Raise MONTHLY_CAP_USD in the Worker settings, or wait until next month.' };
  }
  if ((o.clientSecsToday + o.addSecs) / 60 > o.dailyMin) {
    return { ok: false, code: 'daily_cap', message: 'This device has used its ' + o.dailyMin + ' audio minutes for today. It resets at midnight UTC.' };
  }
  return { ok: true };
}

async function loadUsage(env, clientId) {
  const res = await env.DB.batch([
    env.DB.prepare('SELECT COALESCE(SUM(est_cost_usd),0) AS cost, COALESCE(SUM(seconds),0) AS secs FROM usage WHERE day >= ?').bind(monthStart()),
    env.DB.prepare('SELECT COALESCE(SUM(seconds),0) AS secs FROM usage WHERE day = ? AND client_id = ?').bind(dayStr(), clientId)
  ]);
  const m = (res[0].results && res[0].results[0]) || { cost: 0, secs: 0 };
  const d = (res[1].results && res[1].results[0]) || { secs: 0 };
  return { monthCostUsd: Number(m.cost) || 0, monthSecs: Number(m.secs) || 0, clientSecsToday: Number(d.secs) || 0 };
}

function estCost(c, engine, secs) {
  const rate = engine === 'gemini' ? num(c.COST_GEMINI_PER_MIN_USD, 0.005) : num(c.COST_WHISPER_PER_MIN_USD, 0.00051);
  return (secs / 60) * rate;
}

/* ---------- 6. Text tools: fixes and word list ---------- */
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function applyRulesToText(text, rules) {
  let out = String(text || '');
  for (const r of rules || []) {
    if (!r || !r.wrong) continue;
    const han = /\p{Script=Han}/u.test(r.wrong); // Chinese has no spaces between words, so no word-edge check
    const re = new RegExp(han ? escapeRegex(r.wrong) : '(?<![\\p{L}\\p{N}_])' + escapeRegex(r.wrong) + '(?![\\p{L}\\p{N}_])', 'giu');
    out = out.replace(re, (m) => {
      const right = String(r.right || '');
      if (m[0] && m[0] !== m[0].toLowerCase() && m[0] === m[0].toUpperCase() && right) return right[0].toUpperCase() + right.slice(1);
      return right;
    });
  }
  return out;
}

function pickEngines(av, lang, requested) {
  const supports = { gemini: lang.gemini !== null, whisper: true };
  const pref = lang.engine;
  const other = pref === 'gemini' ? 'whisper' : 'gemini';
  let want;
  if (requested === 'both') want = [pref, other];
  else if (requested === 'gemini') want = ['gemini'];
  else if (requested === 'whisper') want = ['whisper'];
  else want = [pref, other];
  const usable = want.filter((e) => av[e] && supports[e]);
  if (requested === 'auto') return { engines: usable.slice(0, 1), fallback: usable[1] || null };
  return { engines: usable, fallback: null };
}

function whyNoEngine(av, lang, requested) {
  const bits = [];
  if (requested === 'gemini' && lang.gemini === null) bits.push('Gemini does not list ' + lang.label + '.');
  if (!av.gemini) bits.push('Gemini is off (needs GEMINI_API_KEY and GEMINI_ENABLED=1).');
  if (!av.whisper) bits.push('Whisper is off (needs the AI binding).');
  return 'No speech engine is available for ' + lang.label + '. ' + bits.join(' ');
}

/* ---------- 7. Speech engines ---------- */
function engineError(engine, code, message, status) {
  const e = new Error(message);
  e.engine = engine;
  e.code = code;
  e.httpStatus = status || 0;
  return e;
}

async function readErrText(res) {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      return cleanStr((j.error && (j.error.message || j.error.status)) || t, 240);
    } catch (e) { return cleanStr(t, 240); }
  } catch (e) { return ''; }
}

function geminiStatusMessage(status, detail) {
  if (status === 400) return 'Gemini rejected the request (audio format or settings). ' + detail;
  if (status === 401 || status === 403) return 'Gemini did not accept the key. Check GEMINI_API_KEY and that the Gemini API is allowed for it. ' + detail;
  if (status === 404) return 'Gemini could not find the model. Check GEMINI_MODEL. ' + detail;
  if (status === 429) return 'Gemini quota or rate limit reached. Wait a minute or check your Google billing. ' + detail;
  if (status >= 500) return 'Gemini is temporarily unavailable. Try again shortly. ' + detail;
  return 'Gemini returned an error (' + status + '). ' + detail;
}

async function runGemini(env, c, ctx, p) {
  const key = env.GEMINI_API_KEY;
  const gm = p.geminiMime;
  const len = p.buf.byteLength;
  const sig = AbortSignal.timeout(100000);

  // 1) start a resumable upload (documented Files API flow)
  const start = await fetch(GEMINI_BASE + '/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(len),
      'X-Goog-Upload-Header-Content-Type': gm,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'rzt-' + p.shortId } }),
    signal: sig
  });
  if (!start.ok) throw engineError('gemini', 'upload_start', geminiStatusMessage(start.status, await readErrText(start)), start.status);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw engineError('gemini', 'upload_url', 'Gemini did not return an upload address.', 0);

  // 2) send the bytes and finalize
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: p.buf,
    signal: sig
  });
  if (!up.ok) throw engineError('gemini', 'upload', geminiStatusMessage(up.status, await readErrText(up)), up.status);
  const info = await up.json();
  const file = (info && info.file) || {};
  if (!file.uri) throw engineError('gemini', 'upload_info', 'Gemini accepted the upload but returned no file address.', 0);
  const cleanup = () => {
    if (!file.name) return;
    ctx.waitUntil(fetch(GEMINI_BASE + '/v1beta/' + file.name, { method: 'DELETE', headers: { 'x-goog-api-key': key } }).catch(() => {}));
  };

  try {
    // audio is normally ACTIVE at once; wait briefly if not
    let state = file.state;
    for (let i = 0; i < 8 && state && state !== 'ACTIVE'; i++) {
      if (state === 'FAILED') throw engineError('gemini', 'file_failed', 'Gemini could not process this audio file.', 0);
      await sleep(800);
      const g = await fetch(GEMINI_BASE + '/v1beta/' + file.name, { headers: { 'x-goog-api-key': key }, signal: sig });
      if (g.ok) { const gi = await g.json(); state = gi.state || (gi.file && gi.file.state); } else break;
    }

    // 3) transcribe
    const cfg = { languageCodes: p.lang.gemini || [] };
    if (p.terms.length) cfg.customVocabulary = p.terms;
    if (p.mode === 'SMART') cfg.mode = 'SMART';
    const gen = await fetch(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(c.GEMINI_MODEL) + ':generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ fileData: { fileUri: file.uri, mimeType: gm } }] }],
        generationConfig: { audioTranscriptionConfig: cfg }
      }),
      signal: sig
    });
    if (!gen.ok) throw engineError('gemini', 'generate', geminiStatusMessage(gen.status, await readErrText(gen)), gen.status);
    const data = await gen.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('').trim();
    if (!text) {
      const why = (data && data.promptFeedback && data.promptFeedback.blockReason) ? ' (blocked: ' + data.promptFeedback.blockReason + ')' : '';
      throw engineError('gemini', 'empty', 'Gemini returned no text. The clip may be silent or too noisy' + why + '.', 0);
    }
    return { text, language: null };
  } finally {
    cleanup();
  }
}

async function runWhisper(env, c, p) {
  const audio = bytesToBase64(new Uint8Array(p.buf));
  const input = { audio, task: 'transcribe' };
  if (p.lang.whisper) input.language = p.lang.whisper;
  if (c.WHISPER_VAD === '1') input.vad_filter = true;
  if (p.terms.length) input.initial_prompt = cleanStr(p.terms.slice(0, 40).join(', '), 300);
  let out;
  try {
    out = await env.AI.run(c.WHISPER_MODEL, input);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/vad_filter/i.test(msg) && input.vad_filter) {
      delete input.vad_filter;
      try { out = await env.AI.run(c.WHISPER_MODEL, input); } catch (e2) { throw whisperFail(e2); }
    } else {
      throw whisperFail(e);
    }
  }
  const text = cleanStr(out && out.text, 200000);
  if (!text) throw engineError('whisper', 'empty', 'Whisper returned no text. The clip may be silent, or its format was not readable (try mp3 or wav).', 0);
  return { text, language: (out && out.transcription_info && out.transcription_info.language) || null };
}

function whisperFail(e) {
  const msg = cleanStr(e && e.message ? e.message : e, 240);
  if (/decode|format|ffmpeg|invalid|unsupported/i.test(msg)) {
    return engineError('whisper', 'format', 'Whisper could not read this audio format. Try a clip saved as mp3 or wav, or use Gemini. (' + msg + ')', 0);
  }
  return engineError('whisper', 'run', 'Whisper failed. ' + msg, 0);
}

async function runOne(env, c, ctx, engine, p) {
  const t0 = Date.now();
  try {
    const r = engine === 'gemini' ? await runGemini(env, c, ctx, p) : await runWhisper(env, c, p);
    return { engine, ok: true, text: r.text, language: r.language, ms: Date.now() - t0, error: null, errorCode: null };
  } catch (e) {
    const name = (e && e.name) || '';
    const timeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      engine, ok: false, text: '', language: null, ms: Date.now() - t0,
      error: timeout ? 'The engine took too long to answer. Try a shorter clip.' : cleanStr(e && e.message, 400),
      errorCode: timeout ? 'timeout' : (e && e.code) || 'engine_error'
    };
  }
}

/* ---------- 8. Handlers ---------- */
async function readJson(request, maxBytes) {
  const max = maxBytes || 200000;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new HttpError(413, 'too_large', 'That request is too large.');
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, 'too_large', 'That request is too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.'); }
}

function engineAvailability(env, c) {
  return { gemini: !!(env.GEMINI_API_KEY && c.GEMINI_ENABLED === '1'), whisper: !!env.AI };
}

async function handleHealth(env) {
  const c = conf(env);
  const out = {
    ok: true, name: 'Reysourcez-Transcriber-worker', version: VERSION, build: BUILD_DATE, time: nowIso(),
    checks: { accessCodeSet: !!env.ACCESS_CODE, db: false, schemaVersion: null, ai: !!env.AI, geminiKey: !!env.GEMINI_API_KEY, geminiEnabled: c.GEMINI_ENABLED === '1', r2: !!env.AUDIO },
    hints: []
  };
  if (env.DB) {
    try {
      await ensureSchema(env);
      const row = await env.DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first();
      out.checks.db = true;
      out.checks.schemaVersion = row ? Number(row.value) : null;
    } catch (e) {
      out.ok = false;
      out.checks.dbError = cleanStr(e && e.message, 200);
      out.hints.push('The database did not answer. Check the D1 binding named DB.');
    }
  } else {
    out.ok = false;
    out.hints.push('Add a D1 binding named DB.');
  }
  if (!env.ACCESS_CODE) { out.ok = false; out.hints.push('Add the secret ACCESS_CODE.'); }
  if (!env.AI) out.hints.push('Add a Workers AI binding named AI (needed for Tamil and as a backup engine).');
  if (!env.GEMINI_API_KEY) out.hints.push('Gemini is off: add GEMINI_API_KEY, turn on billing for the Google project, then set GEMINI_ENABLED to 1.');
  else if (c.GEMINI_ENABLED !== '1') out.hints.push('Gemini key found but GEMINI_ENABLED is not 1. Set it to 1 after turning on billing.');
  if (!env.AUDIO) out.hints.push('Optional: add an R2 binding named AUDIO if you want to keep audio (with consent).');
  return json(out, 200);
}

async function handleConfig(rc) {
  const { env, c, auth } = rc;
  const av = engineAvailability(env, c);
  const consent = await getConsent(env, auth.clientId, c.CONSENT_VERSION);
  return json({
    ok: true, version: VERSION, build: BUILD_DATE, consentVersion: c.CONSENT_VERSION, consent,
    engines: { gemini: av.gemini, whisper: av.whisper, r2: !!env.AUDIO },
    languages: Object.values(LANGS).map((l) => ({
      id: l.id, label: l.label, status: l.status, lexicons: l.lexicons,
      geminiOk: l.gemini !== null && av.gemini, whisperOk: av.whisper
    })),
    limits: {
      maxUploadMB: num(c.MAX_UPLOAD_MB, 20), maxSegmentSec: num(c.MAX_SEGMENT_SEC, 1800),
      dailyMinPerClient: num(c.DAILY_MIN_PER_CLIENT, 120), monthlyCapUsd: num(c.MONTHLY_CAP_USD, 5),
      retentionDays: num(c.RETENTION_DAYS, 90), ruleMinSeen: num(c.RULE_MIN_SEEN, 3)
    }
  });
}

async function handleConsent(rc) {
  const { request, env, c, auth, method } = rc;
  if (method === 'GET') return json({ ok: true, version: c.CONSENT_VERSION, consent: await getConsent(env, auth.clientId, c.CONSENT_VERSION) });
  const b = await readJson(request, 4000);
  if (String(b.version || '') !== c.CONSENT_VERSION) throw new HttpError(409, 'consent_version', 'The consent wording changed. Reload the page and read it again.');
  const t = nowIso();
  const rows = [['processing', !!b.processing], ['participants', !!b.participants], ['keep_audio', !!b.keepAudio]];
  await env.DB.batch(rows.map((r) => env.DB.prepare('INSERT INTO consent_log(id, client_id, scope, version, granted, created_at) VALUES(?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), auth.clientId, r[0], c.CONSENT_VERSION, r[1] ? 1 : 0, t)));
  return json({ ok: true, consent: await getConsent(env, auth.clientId, c.CONSENT_VERSION) });
}

async function getBiasTerms(env, lang, max) {
  const keys = lang.lexicons || [];
  if (!keys.length) return [];
  const ph = keys.map(() => '?').join(',');
  const r = await env.DB.prepare("SELECT term FROM lexicon_terms WHERE language IN (" + ph + ") AND status != 'rejected' ORDER BY CASE status WHEN 'verified' THEN 0 ELSE 1 END, created_at DESC LIMIT ?")
    .bind(...keys, max).all();
  const seen = new Set();
  const out = [];
  for (const row of (r.results || [])) {
    const t = cleanStr(row.term, 60);
    const k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

async function getApprovedRules(env, langId) {
  const r = await env.DB.prepare("SELECT wrong, right FROM rules WHERE approved=1 AND language IN (?, 'all') ORDER BY length(wrong) DESC LIMIT 500").bind(langId).all();
  return r.results || [];
}

async function handleTranscribe(rc) {
  const { request, env, ctx, url, auth, c } = rc;
  const q = url.searchParams;
  const lang = langOf(q.get('lang'));
  const requested = ['auto', 'gemini', 'whisper', 'both'].includes(q.get('engine')) ? q.get('engine') : 'auto';
  const rid = isId(q.get('rid')) ? q.get('rid') : crypto.randomUUID();
  const idx = clamp(Math.floor(num(q.get('idx'), 0)), 0, 9999);
  const clientDur = clamp(num(q.get('dur'), 0), 0, 7200);
  const src = SOURCES.includes(q.get('src')) ? q.get('src') : 'mic';
  const keep = q.get('keep') === '1';
  const force = q.get('force') === '1';
  const mode = q.get('mode') === 'smart' ? 'SMART' : 'VERBATIM';
  const title = cleanStr(q.get('title'), 120);
  const mime = normalizeMime(request.headers.get('Content-Type'));
  const gm = geminiMime(mime);
  const maxBytes = num(c.MAX_UPLOAD_MB, 20) * 1024 * 1024;

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'This audio part is larger than ' + num(c.MAX_UPLOAD_MB, 20) + ' MB. Record in shorter parts or use a smaller file.');
  if (!gm && !/^audio\//.test(mime)) throw new HttpError(415, 'bad_type', 'This file type (' + mime + ') is not an audio type the engines accept. Use webm, m4a, mp3, wav, ogg, flac or aac.');

  const consent = await getConsent(env, auth.clientId, c.CONSENT_VERSION);
  if (!consent.processing || !consent.participants) throw new HttpError(403, 'consent_required', 'Please accept the consent notice in Setup before recording or uploading.');

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'empty_audio', 'No audio was received.');
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'too_large', 'This audio part is larger than ' + num(c.MAX_UPLOAD_MB, 20) + ' MB.');
  const maxSec = num(c.MAX_SEGMENT_SEC, 1800);
  if (clientDur > maxSec) throw new HttpError(413, 'too_long', 'This part is longer than ' + Math.round(maxSec / 60) + ' minutes. Record in shorter parts.');

  const av = engineAvailability(env, c);
  const plan = pickEngines(av, lang, requested);
  if (!plan.engines.length) throw new HttpError(400, 'no_engine', whyNoEngine(av, lang, requested));
  if (gm === null && plan.engines.includes('gemini')) {
    // Whisper may still accept it; Gemini cannot.
    if (plan.engines.length === 1 && requested !== 'auto') throw new HttpError(415, 'bad_type', 'Gemini does not accept ' + mime + '.');
  }

  // Count cost on whichever is longer: the page's number or what the byte size implies at a very high bitrate.
  const secs = Math.min(maxSec, Math.max(clientDur, buf.byteLength / 40000));
  const usage = await loadUsage(env, auth.clientId);
  const worstCost = plan.engines.concat(plan.fallback ? [plan.fallback] : []).reduce((a, e) => a + estCost(c, e, secs), 0);
  const cap = checkCaps({
    monthCostUsd: usage.monthCostUsd, addCostUsd: worstCost, capUsd: num(c.MONTHLY_CAP_USD, 5),
    clientSecsToday: usage.clientSecsToday, addSecs: secs, dailyMin: num(c.DAILY_MIN_PER_CLIENT, 120)
  });
  if (!cap.ok) throw new HttpError(429, cap.code, cap.message);

  // Recording ownership and cached part (a retry must not be charged twice)
  const rec = await env.DB.prepare('SELECT client_id FROM recordings WHERE id=?').bind(rid).first();
  if (rec && rec.client_id !== auth.clientId) throw new HttpError(403, 'not_yours', 'That recording belongs to another device.');
  const existing = await env.DB.prepare('SELECT id, text_raw, text_final, engine FROM segments WHERE recording_id=? AND idx=?').bind(rid, idx).first();
  if (existing && existing.text_raw && !force) {
    const runs = await env.DB.prepare('SELECT engine, ok, text, error, ms, est_cost_usd, wer FROM engine_runs WHERE segment_id=?').bind(existing.id).all();
    return json({
      ok: true, cached: true, recordingId: rid, segmentId: existing.id, idx, primary: existing.engine, text: existing.text_final || existing.text_raw,
      results: (runs.results || []).map((r) => ({ engine: r.engine, ok: r.ok === 1, text: r.text || '', error: r.error, ms: r.ms, estCostUsd: r.est_cost_usd, wer: r.wer })),
      notes: ['This part was already transcribed; showing the saved result (no new charge).'], version: VERSION
    });
  }

  const terms = await getBiasTerms(env, lang, clamp(Math.floor(num(c.BIAS_TERMS_MAX, 100)), 0, 1000));
  const params = { buf, geminiMime: gm, lang, terms, mode, shortId: rid.slice(0, 8) + '-' + idx };

  // Run the planned engines in parallel; if a lone "auto" engine fails, try the backup.
  let runs = await Promise.all(plan.engines.map((e) => runOne(env, c, ctx, e, params)));
  if (requested === 'auto' && plan.fallback && !runs.some((r) => r.ok)) {
    runs = runs.concat([await runOne(env, c, ctx, plan.fallback, params)]);
  }
  const okRuns = runs.filter((r) => r.ok);
  if (!okRuns.length) {
    const first = runs[0] || { error: 'No engine answered.', errorCode: 'engine_error' };
    await logErrorRow(env, '/api/transcribe', first.errorCode, first.error, 'lang=' + lang.id + ' engine=' + requested + ' bytes=' + buf.byteLength);
    throw new HttpError(502, 'engine_failed', first.error, { results: runs.map((r) => ({ engine: r.engine, ok: false, error: r.error, errorCode: r.errorCode, ms: r.ms })) });
  }

  const primary = okRuns[0];
  const rules = await getApprovedRules(env, lang.id);
  const textFinal = applyRulesToText(primary.text, rules);

  const notes = [];
  let r2Key = null;
  if (keep) {
    if (env.AUDIO && consent.keep_audio) {
      r2Key = 'audio/' + dayStr().slice(0, 7) + '/' + rid + '/' + idx + '.' + extFor(mime);
      try {
        await env.AUDIO.put(r2Key, buf, { httpMetadata: { contentType: mime }, customMetadata: { rid, idx: String(idx), lang: lang.id } });
      } catch (e) { r2Key = null; notes.push('Audio could not be saved to storage.'); }
    } else {
      notes.push('Audio was not kept: ' + (!env.AUDIO ? 'no R2 storage is connected.' : 'the keep-audio consent is off.'));
    }
  }

  const segId = existing ? existing.id : crypto.randomUUID();
  const t = nowIso();
  const stmts = [];
  stmts.push(env.DB.prepare('INSERT OR IGNORE INTO recordings(id, client_id, created_at, title, language, source, keep_audio, consent_version) VALUES(?,?,?,?,?,?,?,?)')
    .bind(rid, auth.clientId, t, title || null, lang.id, src, r2Key ? 1 : 0, c.CONSENT_VERSION));
  stmts.push(env.DB.prepare('INSERT INTO segments(id, recording_id, idx, created_at, duration_sec, mime, bytes, r2_key, text_raw, text_final, engine, lang_detected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(recording_id, idx) DO UPDATE SET duration_sec=excluded.duration_sec, mime=excluded.mime, bytes=excluded.bytes, r2_key=COALESCE(excluded.r2_key, r2_key), text_raw=excluded.text_raw, text_final=excluded.text_final, engine=excluded.engine, lang_detected=excluded.lang_detected')
    .bind(segId, rid, idx, t, clientDur || null, mime, buf.byteLength, nul(r2Key), primary.text, textFinal, primary.engine, nul(primary.language)));
  stmts.push(env.DB.prepare('DELETE FROM engine_runs WHERE segment_id=?').bind(segId));
  const results = [];
  for (const r of runs) {
    const cost = r.ok ? estCost(c, r.engine, secs) : 0;
    stmts.push(env.DB.prepare('INSERT INTO engine_runs(id, segment_id, engine, ok, ms, est_cost_usd, text, error, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), segId, r.engine, r.ok ? 1 : 0, r.ms, cost, r.ok ? r.text : null, nul(r.error), t));
    if (r.ok) {
      stmts.push(env.DB.prepare('INSERT INTO usage(day, client_id, engine, seconds, est_cost_usd) VALUES(?,?,?,?,?) ON CONFLICT(day, client_id, engine) DO UPDATE SET seconds = seconds + excluded.seconds, est_cost_usd = est_cost_usd + excluded.est_cost_usd')
        .bind(dayStr(), auth.clientId, r.engine, secs, cost));
    }
    results.push({ engine: r.engine, ok: r.ok, text: r.ok ? r.text : '', error: r.error, errorCode: r.errorCode, ms: r.ms, estCostUsd: cost });
  }
  await env.DB.batch(stmts);

  logEvent('info', 'transcribed', { rid: rid.slice(0, 8), idx, lang: lang.id, engines: runs.map((r) => r.engine + ':' + (r.ok ? 'ok' : 'fail')), bytes: buf.byteLength, secs: Math.round(secs) });
  return json({
    ok: true, cached: false, recordingId: rid, segmentId: segId, idx, primary: primary.engine, text: textFinal, results, notes,
    usage: { monthCostUsd: usage.monthCostUsd + results.reduce((a, r) => a + (r.estCostUsd || 0), 0) }, version: VERSION
  });
}

async function ownedRecording(env, clientId, id) {
  const row = await env.DB.prepare('SELECT id, client_id, created_at, title, language, source, keep_audio FROM recordings WHERE id=?').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found', 'That recording was not found.');
  if (row.client_id !== clientId) throw new HttpError(403, 'not_yours', 'That recording belongs to another device.');
  return row;
}

async function handleRecordings(rc, id) {
  const { request, env, auth, method, url } = rc;
  if (!id) {
    const limit = clamp(Math.floor(num(url.searchParams.get('limit'), 20)), 1, 50);
    const r = await env.DB.prepare('SELECT r.id, r.created_at, r.title, r.language, r.source, COUNT(s.id) AS parts, COALESCE(SUM(s.duration_sec),0) AS secs FROM recordings r LEFT JOIN segments s ON s.recording_id = r.id WHERE r.client_id=? GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?')
      .bind(auth.clientId, limit).all();
    return json({ ok: true, recordings: r.results || [] });
  }
  const rec = await ownedRecording(env, auth.clientId, id);
  if (method === 'GET') {
    const segs = await env.DB.prepare('SELECT id, idx, duration_sec, text_raw, text_final, engine, r2_key FROM segments WHERE recording_id=? ORDER BY idx').bind(id).all();
    const list = segs.results || [];
    const out = [];
    for (const s of list) {
      const runs = await env.DB.prepare('SELECT engine, ok, text, error, ms, wer, ref_words FROM engine_runs WHERE segment_id=?').bind(s.id).all();
      out.push({ id: s.id, idx: s.idx, durationSec: s.duration_sec, textRaw: s.text_raw, text: s.text_final, engine: s.engine, kept: !!s.r2_key,
        runs: (runs.results || []).map((r) => ({ engine: r.engine, ok: r.ok === 1, text: r.text || '', error: r.error, ms: r.ms, wer: r.wer, refWords: r.ref_words })) });
    }
    return json({ ok: true, recording: rec, segments: out });
  }
  if (method === 'PATCH') {
    const b = await readJson(request, 2000);
    await env.DB.prepare('UPDATE recordings SET title=? WHERE id=?').bind(cleanStr(b.title, 120) || null, id).run();
    return json({ ok: true });
  }
  if (method === 'DELETE') {
    const segs = await env.DB.prepare('SELECT id, r2_key FROM segments WHERE recording_id=?').bind(id).all();
    for (const s of (segs.results || [])) {
      if (s.r2_key && env.AUDIO) { try { await env.AUDIO.delete(s.r2_key); } catch (e) { /* keep going */ } }
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM engine_runs WHERE segment_id IN (SELECT id FROM segments WHERE recording_id=?)').bind(id),
      env.DB.prepare('DELETE FROM corrections WHERE segment_id IN (SELECT id FROM segments WHERE recording_id=?)').bind(id),
      env.DB.prepare('DELETE FROM segments WHERE recording_id=?').bind(id),
      env.DB.prepare('DELETE FROM recordings WHERE id=?').bind(id)
    ]);
    return json({ ok: true, deleted: true });
  }
  throw new HttpError(405, 'method', 'That action is not allowed here.');
}

function cleanWord(s) { return cleanStr(String(s || '').normalize('NFKC'), 40).replace(/\s+/g, ' '); }

async function handleCorrection(rc) {
  const { request, env, auth, c } = rc;
  const b = await readJson(request, 400000);
  if (!isId(b.segmentId) && !/^[0-9a-f-]{36}$/i.test(String(b.segmentId || ''))) throw new HttpError(400, 'bad_segment', 'Missing part ID.');
  const after = cleanStr(b.after, 200000);
  const seg = await env.DB.prepare('SELECT s.id AS id, s.text_final AS text_final, r.client_id AS client_id, r.language AS language FROM segments s JOIN recordings r ON r.id = s.recording_id WHERE s.id=?').bind(b.segmentId).first();
  if (!seg) throw new HttpError(404, 'not_found', 'That part was not found.');
  if (seg.client_id !== auth.clientId) throw new HttpError(403, 'not_yours', 'That part belongs to another device.');
  const before = seg.text_final || '';
  if (after === before) return json({ ok: true, changed: false, suggestions: { newWords: [], rules: [] } });

  const lang = langOf(seg.language);
  const stmts = [
    env.DB.prepare('UPDATE segments SET text_final=? WHERE id=?').bind(after, seg.id),
    env.DB.prepare('INSERT INTO corrections(id, segment_id, client_id, language, before_text, after_text, created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), seg.id, auth.clientId, lang.id, before, after, nowIso())
  ];
  const pairs = (Array.isArray(b.pairs) ? b.pairs : []).slice(0, 50)
    .map((p) => ({ wrong: cleanWord(p && p.w), right: cleanWord(p && p.r) }))
    .filter((p) => p.wrong && p.right && p.wrong.toLowerCase() !== p.right.toLowerCase());
  for (const p of pairs) {
    stmts.push(env.DB.prepare('INSERT INTO rules(id, language, wrong, right, seen, approved, created_at) VALUES(?,?,?,?,1,0,?) ON CONFLICT(language, wrong, right) DO UPDATE SET seen = seen + 1')
      .bind(crypto.randomUUID(), lang.id, p.wrong, p.right, nowIso()));
  }
  await env.DB.batch(stmts);

  // Suggestions for the page
  const minSeen = num(c.RULE_MIN_SEEN, 3);
  const rules = [];
  for (const p of pairs.slice(0, 20)) {
    const r = await env.DB.prepare('SELECT id, wrong, right, seen, approved FROM rules WHERE language=? AND wrong=? AND right=?').bind(lang.id, p.wrong, p.right).first();
    if (r && r.approved === 0 && r.seen >= minSeen) rules.push({ id: r.id, wrong: r.wrong, right: r.right, seen: r.seen });
  }
  let newWords = [];
  const words = Array.from(new Set((Array.isArray(b.newWords) ? b.newWords : []).slice(0, 50).map(cleanWord).filter((w) => w.length >= 3 && !/^[\d\W]+$/u.test(w))));
  if (words.length) {
    const keys = lang.lexicons;
    const ph1 = keys.map(() => '?').join(',');
    const ph2 = words.map(() => '?').join(',');
    const have = await env.DB.prepare('SELECT LOWER(term) AS t FROM lexicon_terms WHERE language IN (' + ph1 + ') AND LOWER(term) IN (' + ph2 + ')')
      .bind(...keys, ...words.map((w) => w.toLowerCase())).all();
    const haveSet = new Set((have.results || []).map((x) => x.t));
    newWords = words.filter((w) => !haveSet.has(w.toLowerCase())).slice(0, 12);
  }
  return json({ ok: true, changed: true, suggestions: { newWords, rules } });
}

async function handleScore(rc) {
  const { request, env, auth } = rc;
  const b = await readJson(request, 20000);
  const seg = await env.DB.prepare('SELECT s.id AS id, r.client_id AS client_id FROM segments s JOIN recordings r ON r.id = s.recording_id WHERE s.id=?').bind(b.segmentId).first();
  if (!seg) throw new HttpError(404, 'not_found', 'That part was not found.');
  if (seg.client_id !== auth.clientId) throw new HttpError(403, 'not_yours', 'That part belongs to another device.');
  const scores = b.scores && typeof b.scores === 'object' ? b.scores : {};
  const stmts = [];
  for (const engine of ['gemini', 'whisper']) {
    const s = scores[engine];
    if (!s) continue;
    const wer = Number(s.wer);
    const refWords = Math.floor(Number(s.refWords));
    if (!Number.isFinite(wer) || wer < 0 || wer > 10 || !Number.isFinite(refWords) || refWords < 1) continue;
    stmts.push(env.DB.prepare('UPDATE engine_runs SET wer=?, ref_words=? WHERE segment_id=? AND engine=?').bind(wer, refWords, seg.id, engine));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, saved: stmts.length });
}

async function handleLexicon(rc, id) {
  const { request, env, auth, method, url, c } = rc;
  if (method === 'GET') {
    const lang = cleanStr(url.searchParams.get('lang'), 20);
    const q = cleanStr(url.searchParams.get('q'), 60).toLowerCase();
    const limit = clamp(Math.floor(num(url.searchParams.get('limit'), 200)), 1, 500);
    const where = [];
    const binds = [];
    if (LEX_KEYS.includes(lang)) { where.push('language=?'); binds.push(lang); }
    if (q) { where.push("LOWER(term) LIKE ? ESCAPE '\\'"); binds.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); }
    const r = await env.DB.prepare('SELECT id, language, term, meaning, variants, source, status, created_at FROM lexicon_terms' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY language, term LIMIT ?')
      .bind(...binds, limit).all();
    const cnt = await env.DB.prepare('SELECT language, COUNT(*) AS n FROM lexicon_terms GROUP BY language').all();
    return json({ ok: true, terms: r.results || [], counts: cnt.results || [], biasMax: num(c.BIAS_TERMS_MAX, 100) });
  }
  if (method === 'POST') {
    const b = await readJson(request, 300000);
    const items = (Array.isArray(b.items) ? b.items : [b]).slice(0, 500);
    const t = nowIso();
    const stmts = [];
    let skipped = 0;
    for (const it of items) {
      const language = cleanStr(it && it.language, 20);
      const term = cleanStr(it && it.term, 60).replace(/\s+/g, ' ');
      if (!LEX_KEYS.includes(language) || !term) { skipped++; continue; }
      stmts.push(env.DB.prepare("INSERT INTO lexicon_terms(id, language, term, meaning, variants, source, status, created_at, created_by) VALUES(?,?,?,?,?,?, 'unverified', ?, ?) ON CONFLICT(language, term) DO UPDATE SET meaning = COALESCE(NULLIF(excluded.meaning,''), meaning), variants = COALESCE(NULLIF(excluded.variants,''), variants), source = COALESCE(NULLIF(excluded.source,''), source)")
        .bind(crypto.randomUUID(), language, term, cleanStr(it.meaning, 200) || null, cleanStr(it.variants, 200) || null, cleanStr(it.source, 120) || null, t, auth.clientId.slice(0, 8)));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ ok: true, saved: stmts.length, skipped });
  }
  requireAdmin(request, env);
  if (!id) throw new HttpError(400, 'missing_id', 'Missing term ID.');
  if (method === 'PATCH') {
    const b = await readJson(request, 2000);
    const status = ['verified', 'unverified', 'rejected'].includes(b.status) ? b.status : null;
    if (!status) throw new HttpError(400, 'bad_status', 'Status must be verified, unverified or rejected.');
    await env.DB.prepare('UPDATE lexicon_terms SET status=? WHERE id=?').bind(status, id).run();
    return json({ ok: true });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM lexicon_terms WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'method', 'That action is not allowed here.');
}

async function handleRules(rc, id, action) {
  const { request, env, method, url, c } = rc;
  if (method === 'GET' && !id) {
    const status = url.searchParams.get('status') === 'approved' ? 'approved' : 'suggested';
    const r = status === 'approved'
      ? await env.DB.prepare('SELECT id, language, wrong, right, seen FROM rules WHERE approved=1 ORDER BY language, wrong LIMIT 200').all()
      : await env.DB.prepare('SELECT id, language, wrong, right, seen FROM rules WHERE approved=0 AND seen>=? ORDER BY seen DESC LIMIT 100').bind(num(c.RULE_MIN_SEEN, 3)).all();
    return json({ ok: true, status, rules: r.results || [] });
  }
  requireAdmin(request, env);
  if (!id) throw new HttpError(400, 'missing_id', 'Missing rule ID.');
  if (method === 'POST' && action === 'approve') {
    await env.DB.prepare('UPDATE rules SET approved=1 WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM rules WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'method', 'That action is not allowed here.');
}

async function handleUsage(rc) {
  const { env, auth, c } = rc;
  const u = await loadUsage(env, auth.clientId);
  const capUsd = num(c.MONTHLY_CAP_USD, 5);
  const dailyMin = num(c.DAILY_MIN_PER_CLIENT, 120);
  return json({
    ok: true, day: dayStr(), month: monthStart().slice(0, 7),
    device: { minutesToday: u.clientSecsToday / 60, dailyMin },
    site: { minutesMonth: u.monthSecs / 60, costMonthUsd: u.monthCostUsd, capUsd },
    note: 'Costs are estimates from list prices; check Google and Cloudflare billing for the real figures.'
  });
}

async function handleClientLog(rc) {
  const { request, env, auth } = rc;
  const b = await readJson(request, 6000);
  const id = await logErrorRow(env, 'client:' + auth.clientId.slice(0, 8), cleanStr(b.code, 60) || 'client', cleanStr(b.message, 400), cleanStr(b.detail, 1500));
  return json({ ok: true, ref: id });
}

async function purgeExpiredAudio(env) {
  if (!env.AUDIO || !env.DB) return;
  await ensureSchema(env);
  const c = conf(env);
  const cutoff = new Date(Date.now() - num(c.RETENTION_DAYS, 90) * 86400000).toISOString();
  const r = await env.DB.prepare('SELECT id, r2_key FROM segments WHERE r2_key IS NOT NULL AND created_at < ? LIMIT 50').bind(cutoff).all();
  for (const s of (r.results || [])) {
    try { await env.AUDIO.delete(s.r2_key); await env.DB.prepare('UPDATE segments SET r2_key=NULL WHERE id=?').bind(s.id).run(); } catch (e) { /* retry next run */ }
  }
  logEvent('info', 'purged', { count: (r.results || []).length });
}

/* ---------- 9. Router ---------- */
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  if (path === '/') return new Response('Reysourcez Voice Transcriber Worker v' + VERSION + ' - API only.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (path === '/api/health' && method === 'GET') return handleHealth(env);
  if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'No such page.');

  const auth = await requireAuth(request, env);
  const rc = { request, env, ctx, url, auth, c: conf(env), path, method };
  let m;
  if (path === '/api/config' && method === 'GET') return handleConfig(rc);
  if (path === '/api/consent' && (method === 'GET' || method === 'POST')) return handleConsent(rc);
  if (path === '/api/transcribe' && method === 'POST') return handleTranscribe(rc);
  if (path === '/api/recordings' && method === 'GET') return handleRecordings(rc, null);
  if ((m = path.match(/^\/api\/recordings\/([A-Za-z0-9_-]{8,64})$/))) return handleRecordings(rc, m[1]);
  if (path === '/api/corrections' && method === 'POST') return handleCorrection(rc);
  if (path === '/api/score' && method === 'POST') return handleScore(rc);
  if (path === '/api/lexicon' && (method === 'GET' || method === 'POST')) return handleLexicon(rc, null);
  if ((m = path.match(/^\/api\/lexicon\/([A-Za-z0-9_-]{8,64})$/))) return handleLexicon(rc, m[1]);
  if (path === '/api/rules' && method === 'GET') return handleRules(rc, null, null);
  if ((m = path.match(/^\/api\/rules\/([A-Za-z0-9_-]{8,64})\/approve$/))) return handleRules(rc, m[1], 'approve');
  if ((m = path.match(/^\/api\/rules\/([A-Za-z0-9_-]{8,64})$/))) return handleRules(rc, m[1], null);
  if (path === '/api/usage' && method === 'GET') return handleUsage(rc);
  if (path === '/api/log' && method === 'POST') return handleClientLog(rc);
  throw new HttpError(404, 'not_found', 'No such API route.');
}

async function errorResponse(err, request, env) {
  if (err instanceof HttpError) {
    return json(Object.assign({ ok: false, error: err.code, message: err.message }, err.extra || {}), err.status);
  }
  const ref = await logErrorRow(env, new URL(request.url).pathname, 'server_error', String(err && err.message ? err.message : err), String(err && err.stack ? err.stack : ''));
  logEvent('error', 'server_error', { path: new URL(request.url).pathname, message: cleanStr(err && err.message, 200), ref });
  return json({ ok: false, error: 'server_error', message: 'Something went wrong on the server. It was logged' + (ref ? ' (ref ' + ref.slice(0, 8) + ')' : '') + '.', ref }, 500);
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      res = await errorResponse(err, request, env);
    }
    const h = new Headers(res.headers);
    for (const k of Object.keys(cors)) h.set(k, cors[k]);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredAudio(env).catch((e) => logEvent('error', 'purge_failed', { message: cleanStr(e && e.message, 200) })));
  }
};
