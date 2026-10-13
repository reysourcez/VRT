/* ============================================================
   Reysourcez Voice Transcriber - page script
   VERSION 0.2 | file: Reysourcez-Transcriber-recorder_v0.2.js | 2026-10-08
   ------------------------------------------------------------
   What this does
   - Records from the microphone (and, on desktop Chrome/Edge, a meeting tab's
     sound), cuts the recording into parts, sends each part to the Worker,
     shows the transcript, lets you fix it, and teaches the system (word list,
     fixes). Works on desktop, Android and iPhone browsers.
   - Reads page settings from RZ_SITE_CONFIG.transcriber (site-config.js).
   - Holds no keys and no engine rules; the Worker does that.
   Notes: ref rev2.a = first build.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. Settings (fallback if site-config.js has no transcriber block) ---------- */
  var FALLBACK = {
    version: '0.2',
    apiBase: '',
    consentVersion: '2026-10-v1',
    segmentMinutes: 10,
    maxUploadMB: 20,
    audioBitsPerSecond: 32000,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
    tabAudio: true,
    defaultLanguage: 'auto',
    defaultEngine: 'auto'
  };
  var SITE = (typeof RZ_SITE_CONFIG !== 'undefined' && RZ_SITE_CONFIG && RZ_SITE_CONFIG.transcriber) || {};
  var CFG = {};
  Object.keys(FALLBACK).forEach(function (k) { CFG[k] = SITE[k] !== undefined ? SITE[k] : FALLBACK[k]; });

  var MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  var LEX_LABELS = { ms: 'Bahasa Malaysia', 'ms-sarawak': 'Bahasa Sarawak', en: 'English', zh: 'Mandarin', ta: 'Tamil', iban: 'Iban' };

  /* ---------- 2. Pure helpers (also tested in Node) ---------- */
  function mimeBase(m) { return String(m || '').split(';')[0].trim().toLowerCase(); }

  function pickMime(isSupported) {
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try { if (isSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i]; } catch (e) { /* keep trying */ }
    }
    return '';
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function tokens(text) {
    // Chinese characters are counted one by one (a character error rate); other scripts are counted as words.
    return String(text || '').normalize('NFKC').replace(/\p{Script=Han}/gu, ' $& ').match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019\-]*/gu) || [];
  }

  // Word error rate against a reference (the corrected text). Case and punctuation are ignored.
  function wer(ref, hyp) {
    var r = tokens(String(ref || '').toLowerCase());
    var h = tokens(String(hyp || '').toLowerCase());
    var pre = 0;
    while (pre < r.length && pre < h.length && r[pre] === h[pre]) pre++;
    var suf = 0;
    while (suf < r.length - pre && suf < h.length - pre && r[r.length - 1 - suf] === h[h.length - 1 - suf]) suf++;
    var a = r.slice(pre, r.length - suf), b = h.slice(pre, h.length - suf);
    var n = a.length, m = b.length, errors;
    if (n === 0) errors = m;
    else if (m === 0) errors = n;
    else {
      var prev = new Array(m + 1), cur = new Array(m + 1), i, j;
      for (j = 0; j <= m; j++) prev[j] = j;
      for (i = 1; i <= n; i++) {
        cur[0] = i;
        for (j = 1; j <= m; j++) {
          var cost = a[i - 1] === b[j - 1] ? 0 : 1;
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        var t = prev; prev = cur; cur = t;
      }
      errors = prev[m];
    }
    var refWords = r.length;
    return { wer: refWords === 0 ? (errors === 0 ? 0 : 1) : errors / refWords, errors: errors, refWords: refWords };
  }

  // How different are two words, 0 (same) to 1 (nothing in common)? Used to pick the most sensible match.
  function wordDistance(a, b) {
    if (a === b) return 0;
    var n = a.length, m = b.length;
    if (!n || !m) return 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      cur[0] = i;
      for (j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      var t = prev; prev = cur; cur = t;
    }
    return prev[m] / Math.max(n, m);
  }

  // Which words did the person change? Returns one-for-one replacements and brand-new words.
  function diffWords(beforeText, afterText) {
    var a = tokens(beforeText), b = tokens(afterText);
    var al = a.map(function (x) { return x.toLowerCase(); }), bl = b.map(function (x) { return x.toLowerCase(); });
    var seenBefore = {};
    al.forEach(function (x) { seenBefore[x] = true; });
    var newWords = [], seenNew = {};
    b.forEach(function (w, i) {
      var k = bl[i];
      if (!seenBefore[k] && !seenNew[k] && w.length >= 3 && !/^[\d\W]+$/u.test(w)) { seenNew[k] = true; newWords.push(w); }
    });
    var pre = 0;
    while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
    var suf = 0;
    while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++;
    var A = al.slice(pre, al.length - suf), B = bl.slice(pre, bl.length - suf);
    var N = A.length, M = B.length, pairs = [];
    if (N === 0 || M === 0 || N * M > 250000) return { pairs: pairs, newWords: newWords.slice(0, 50) };
    // Edit costs: insert/delete 1; swapping a word costs less the more alike the two words are,
    // so "teh" becomes "the" rather than some unrelated new word.
    var d = [], sub = [], i, j;
    for (i = 0; i <= N; i++) { d.push(new Float64Array(M + 1)); sub.push(new Float64Array(M + 1)); d[i][0] = i; }
    for (j = 0; j <= M; j++) d[0][j] = j;
    for (i = 1; i <= N; i++) {
      for (j = 1; j <= M; j++) {
        sub[i][j] = A[i - 1] === B[j - 1] ? 0 : wordDistance(A[i - 1], B[j - 1]);
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub[i][j]);
      }
    }
    var EPS = 1e-9;
    i = N; j = M;
    while (i > 0 && j > 0) {
      if (Math.abs(d[i][j] - (d[i - 1][j - 1] + sub[i][j])) < EPS) {
        if (sub[i][j] > 0) pairs.push({ w: a[pre + i - 1], r: b[pre + j - 1] });
        i--; j--;
      } else if (Math.abs(d[i][j] - (d[i - 1][j] + 1)) < EPS) i--;
      else j--;
    }
    pairs.reverse();
    return { pairs: pairs.slice(0, 50), newWords: newWords.slice(0, 50) };
  }

  function parseCsv(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    var rows = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < s.length; i++) {
      c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
    return rows;
  }

  function lexiconFromCsv(text) {
    var rows = parseCsv(text);
    if (!rows.length) throw new Error('The file is empty.');
    var head = rows[0].map(function (x) { return String(x).trim().toLowerCase(); });
    var ti = head.indexOf('term'), li = head.indexOf('language');
    if (ti < 0 || li < 0) throw new Error('The first row must be a header with at least: language, term (optional: meaning, variants, source).');
    var mi = head.indexOf('meaning'), vi = head.indexOf('variants'), si = head.indexOf('source');
    var items = [];
    rows.slice(1).forEach(function (r) {
      var term = String(r[ti] || '').trim();
      if (!term || term === 'EXAMPLE_TERM') return;
      items.push({ language: String(r[li] || '').trim(), term: term, meaning: mi >= 0 ? String(r[mi] || '').trim() : '', variants: vi >= 0 ? String(r[vi] || '').trim() : '', source: si >= 0 ? String(r[si] || '').trim() : '' });
    });
    return items;
  }

  function mimeFromName(name, type) {
    var t = mimeBase(type);
    if (/^audio\//.test(t) && t !== 'audio/x-unknown') return t;
    var ext = (String(name || '').split('.').pop() || '').toLowerCase();
    var map = { m4a: 'audio/m4a', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', aac: 'audio/aac' };
    return map[ext] || '';
  }

  function buildTxt(parts, meta) {
    var lines = ['Voice Transcriber v' + CFG.version, 'Language: ' + (meta && meta.language || ''), 'Date: ' + (meta && meta.date || ''), ''];
    var t = 0;
    parts.forEach(function (p) {
      var end = t + (p.dur || 0);
      lines.push('[Part ' + (p.idx + 1) + ', ' + fmtTime(t) + ' to ' + fmtTime(end) + ']');
      lines.push(p.text || '');
      lines.push('');
      t = end;
    });
    return lines.join('\n');
  }

  function retryable(err) {
    if (!err) return false;
    if (err.code === 'network') return true;
    return err.status === 503 || err.status === 504;
  }

  function friendlyError(err) {
    var code = err && err.code, msg = (err && err.message) || 'Something went wrong.';
    if (code === 'network') return msg;
    if (code === 'bad_access_code') return 'The access code is wrong. Enter it again under Set up.';
    if (code === 'consent_required') return 'Save your consent choices under Set up first.';
    if (code === 'too_many_attempts') return msg;
    return msg;
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { pickMime: pickMime, mimeBase: mimeBase, fmtTime: fmtTime, tokens: tokens, wer: wer, diffWords: diffWords, parseCsv: parseCsv, lexiconFromCsv: lexiconFromCsv, mimeFromName: mimeFromName, buildTxt: buildTxt, retryable: retryable, friendlyError: friendlyError, CFG: CFG };
    }
    return;
  }

  /* ---------- 3. Page code ---------- */
  var S = {
    access: '', admin: '', clientId: '', cfg: null, consent: null,
    parts: [], rec: null, pumping: false, log: [], lastLang: CFG.defaultLanguage
  };
  var UA = navigator.userAgent || '';
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  var IS_MOBILE = IS_IOS || /Android/i.test(UA);

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var x = Array.prototype.map.call(b, function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  function logEvt(code, message) {
    S.log.push({ t: new Date().toISOString(), code: code, message: String(message || '').slice(0, 300) });
    if (S.log.length > 100) S.log.shift();
  }
  window.addEventListener('error', function (e) { logEvt('js_error', (e && e.message) + ' @' + (e && e.lineno)); });
  window.addEventListener('unhandledrejection', function (e) { logEvt('promise_rejected', e && e.reason && (e.reason.message || e.reason)); });

  function store(kind) { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; } }
  function sget(key) { var a = store('local'), b = store('session'); return (a && a.getItem(key)) || (b && b.getItem(key)) || ''; }
  function sset(key, val, persist) {
    var a = store('local'), b = store('session');
    try { if (a) a.removeItem(key); if (b) b.removeItem(key); (persist ? a : b) && (persist ? a : b).setItem(key, val); } catch (e) { logEvt('storage', e.message); }
  }

  function setStatus(text, kind) {
    var el = $('rzt-status');
    el.textContent = text || '';
    el.className = 'rzt-status' + (kind ? ' is-' + kind : '');
  }
  function setMsg(id, text, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'rzt-msg' + (kind ? ' is-' + kind : '');
  }

  /* ---------- 4. Talking to the Worker ---------- */
  function apiBase() { return String(CFG.apiBase || '').replace(/\/+$/, ''); }
  function apiConfigured() { return !!apiBase() && !/YOUR-SUBDOMAIN/i.test(apiBase()); }

  function apiError(status, data, fallback) {
    var e = new Error((data && data.message) || fallback || ('The server answered with status ' + status + '.'));
    e.status = status; e.code = (data && data.error) || 'http_' + status; e.data = data || null;
    return e;
  }

  async function api(path, opts) {
    opts = opts || {};
    if (!apiConfigured()) { var ce = new Error('The Worker address is not set. Put it in site-config.js (transcriber.apiBase).'); ce.code = 'no_api'; throw ce; }
    var headers = { 'X-RZ-Access': S.access, 'X-RZ-Client': S.clientId };
    Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
    if (opts.admin) headers['X-RZ-Admin'] = S.admin || S.access;
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    else if (opts.body !== undefined) init.body = opts.body;
    var res;
    try { res = await fetch(apiBase() + path, init); }
    catch (err) {
      var ne = new Error('Could not reach the server. Check your internet. If it keeps happening, the Worker may not allow this page address (' + location.origin + ') in ALLOWED_ORIGINS.');
      ne.code = 'network'; ne.cause = err; logEvt('network', err && err.message); throw ne;
    }
    var data = null;
    try { data = await res.json(); } catch (e2) { /* not JSON */ }
    if (!res.ok || (data && data.ok === false)) { var ae = apiError(res.status, data); logEvt('api_' + ae.code, ae.message); throw ae; }
    return data;
  }

  /* ---------- 5. Set up: connect and consent ---------- */
  function selectedLang() { return $('rzt-lang').value || CFG.defaultLanguage; }
  function langInfo(id) { return (S.cfg && S.cfg.languages || []).filter(function (l) { return l.id === id; })[0] || null; }
  function consentOk() { return !!(S.consent && S.consent.processing && S.consent.participants); }
  function ready() { return !!(S.cfg && consentOk()); }

  function fillLanguages() {
    var sel = $('rzt-lang');
    var prev = sel.value || S.lastLang || CFG.defaultLanguage;
    sel.textContent = '';
    (S.cfg.languages || []).forEach(function (l) {
      var tag = l.status === 'experimental' ? ' (experimental)' : l.status === 'beta' ? ' (beta)' : '';
      var ok = (l.geminiOk || l.whisperOk);
      var o = h('option', { value: l.id, text: l.label.replace(/ \(experimental\)$/, '') + tag + (ok ? '' : ' - no engine on') });
      sel.appendChild(o);
    });
    sel.value = langInfo(prev) ? prev : (langInfo(CFG.defaultLanguage) ? CFG.defaultLanguage : 'auto');
    var lx = $('rzt-lex-lang');
    lx.textContent = '';
    Object.keys(LEX_LABELS).forEach(function (k) { lx.appendChild(h('option', { value: k, text: LEX_LABELS[k] })); });
    lx.value = (langInfo(sel.value) && langInfo(sel.value).lexicons[0]) || 'ms-sarawak';
  }

  function renderConn() {
    var el = $('rzt-conn');
    el.textContent = '';
    if (!apiConfigured()) { el.appendChild(h('span', { class: 'rzt-chip is-bad', text: 'Worker address not set' })); return; }
    if (!S.cfg) { el.appendChild(h('span', { class: 'rzt-chip', text: 'Not connected' })); return; }
    el.appendChild(h('span', { class: 'rzt-chip is-ok', text: 'Connected, Worker v' + S.cfg.version }));
    el.appendChild(h('span', { class: 'rzt-chip ' + (S.cfg.engines.gemini ? 'is-ok' : ''), text: 'Gemini ' + (S.cfg.engines.gemini ? 'on' : 'off') }));
    el.appendChild(h('span', { class: 'rzt-chip ' + (S.cfg.engines.whisper ? 'is-ok' : ''), text: 'Whisper ' + (S.cfg.engines.whisper ? 'on' : 'off') }));
    el.appendChild(h('span', { class: 'rzt-chip', text: 'Audio storage ' + (S.cfg.engines.r2 ? 'on' : 'off') }));
  }

  function renderConsent() {
    var c = S.consent || {};
    $('rzt-c-processing').checked = !!c.processing;
    $('rzt-c-participants').checked = !!c.participants;
    $('rzt-c-keep').checked = !!c.keep_audio;
    $('rzt-c-keep').disabled = !(S.cfg && S.cfg.engines.r2);
    $('rzt-c-keep-note').textContent = S.cfg && S.cfg.engines.r2 ? '' : 'Audio storage is not connected, so this stays off.';
    $('rzt-c-status').textContent = consentOk() ? 'Consent saved on this device.' : 'Consent needed before you can record.';
    $('rzt-c-status').className = 'rzt-msg ' + (consentOk() ? 'is-ok' : 'is-warn');
    $('rzt-keep-wrap').hidden = !(consentOk() && c.keep_audio && S.cfg && S.cfg.engines.r2);
  }

  function updateUi() {
    var can = ready();
    var li = langInfo(selectedLang());
    var hasEngine = !!(li && (li.geminiOk || li.whisperOk));
    $('rzt-rec').disabled = !(can && hasEngine) && !(S.rec);
    $('rzt-file').disabled = !(can && hasEngine);
    $('rzt-file-btn').classList.toggle('is-disabled', !(can && hasEngine));
    if (!S.rec) {
      if (!apiConfigured()) setStatus('Set the Worker address first (site-config.js, transcriber.apiBase).', 'warn');
      else if (!S.cfg) setStatus('Enter the access code under Set up and press Connect.', 'warn');
      else if (!consentOk()) setStatus('Save your consent choices under Set up to start.', 'warn');
      else if (!hasEngine) setStatus('No speech engine is on for ' + (li ? li.label : 'this language') + '. See Diagnostics.', 'warn');
      else if (!$('rzt-status').classList.contains('is-ok')) setStatus('Ready.', 'ok');
    }
    var tabOk = CFG.tabAudio && !IS_MOBILE && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $('rzt-tab-wrap').hidden = !tabOk;
    $('rzt-tab-hint').hidden = !tabOk;
    var engine = $('rzt-engine');
    Array.prototype.forEach.call(engine.options, function (o) {
      if (o.value === 'gemini') o.disabled = !(S.cfg && S.cfg.engines.gemini);
      if (o.value === 'whisper') o.disabled = !(S.cfg && S.cfg.engines.whisper);
      if (o.value === 'both') o.disabled = !(S.cfg && S.cfg.engines.gemini && S.cfg.engines.whisper);
    });
  }

  async function connect() {
    S.access = $('rzt-access').value.trim();
    S.admin = $('rzt-admin').value.trim();
    if (!apiConfigured()) { renderConn(); updateUi(); setMsg('rzt-setup-msg', 'Set transcriber.apiBase in site-config.js to your Worker address first.', 'bad'); return; }
    if (!S.access) { setMsg('rzt-setup-msg', 'Enter the access code.', 'bad'); return; }
    setMsg('rzt-setup-msg', 'Connecting...', '');
    try {
      var cfg = await api('/api/config');
      S.cfg = cfg;
      S.consent = cfg.consent;
      sset('rzt_access', S.access, $('rzt-remember').checked);
      sset('rzt_admin', S.admin, $('rzt-remember').checked);
      store('local') && store('local').setItem('rzt_remember', $('rzt-remember').checked ? '1' : '0');
      fillLanguages(); renderConn(); renderConsent(); updateUi();
      setMsg('rzt-setup-msg', 'Connected.', 'ok');
      if (cfg.consentVersion !== CFG.consentVersion) setMsg('rzt-setup-msg', 'Connected, but the consent wording version differs between page (' + CFG.consentVersion + ') and Worker (' + cfg.consentVersion + '). Make them match.', 'warn');
      refreshUsage(); loadLexicon(); loadRules(); loadHistory();
    } catch (e) {
      S.cfg = null; renderConn(); updateUi();
      setMsg('rzt-setup-msg', friendlyError(e), 'bad');
    }
  }

  async function saveConsent() {
    try {
      var r = await api('/api/consent', { method: 'POST', json: { version: CFG.consentVersion, processing: $('rzt-c-processing').checked, participants: $('rzt-c-participants').checked, keepAudio: $('rzt-c-keep').checked } });
      S.consent = r.consent; renderConsent(); updateUi();
      if (!consentOk()) setMsg('rzt-setup-msg', 'Both required boxes must be ticked to record.', 'warn');
      else setMsg('rzt-setup-msg', '', '');
    } catch (e) { setMsg('rzt-setup-msg', friendlyError(e), 'bad'); }
  }

  /* ---------- 6. Recording ---------- */
  function hasMedia() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined'); }

  async function lockScreen() {
    try { if ('wakeLock' in navigator && S.rec) S.rec.wl = await navigator.wakeLock.request('screen'); } catch (e) { logEvt('wakelock', e.message); }
  }
  document.addEventListener('visibilitychange', function () {
    if (S.rec && !S.rec.stopping && document.visibilityState === 'visible' && (!S.rec.wl || S.rec.wl.released)) lockScreen();
  });

  function meterLoop() {
    var r = S.rec;
    if (!r || r.stopping) return;
    var level = 0;
    if (r.analyser) {
      r.analyser.getByteTimeDomainData(r.buf);
      var sum = 0;
      for (var i = 0; i < r.buf.length; i++) { var v = (r.buf[i] - 128) / 128; sum += v * v; }
      level = Math.min(1, Math.sqrt(sum / r.buf.length) * 4);
    }
    $('rzt-rec').style.setProperty('--level', level.toFixed(2));
    var now = Date.now();
    if (level > 0.02) { r.lastSound = now; if (r.silentWarned) { r.silentWarned = false; setStatus('Recording...', 'rec'); } }
    else if (r.analyser && now - r.lastSound > 20000 && !r.silentWarned) {
      r.silentWarned = true;
      setStatus('No sound for 20 seconds. Is the microphone muted, or is another app or call using it?', 'warn');
      logEvt('silence', 'no input for 20 s');
    }
    r.raf = requestAnimationFrame(meterLoop);
  }

  function startSegment() {
    var r = S.rec;
    var opts = {};
    var mime = pickMime(function (m) { return MediaRecorder.isTypeSupported(m); });
    if (mime) opts.mimeType = mime;
    if (CFG.audioBitsPerSecond) opts.audioBitsPerSecond = CFG.audioBitsPerSecond;
    var mr;
    try { mr = new MediaRecorder(r.stream, opts); } catch (e) { mr = new MediaRecorder(r.stream); }
    var chunks = [], started = Date.now(), idx = r.nextIdx++;
    mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    mr.onerror = function (ev) { logEvt('recorder_error', ev && ev.error && ev.error.message); };
    mr.onstop = function () {
      var type = mr.mimeType || mime || 'audio/webm';
      var blob = new Blob(chunks, { type: type });
      var dur = (Date.now() - started) / 1000;
      if (blob.size > 0 && dur > 0.5) enqueuePart({ blob: blob, idx: idx, dur: dur, rid: r.id, src: r.src, lang: r.lang });
      else logEvt('empty_part', 'part ' + idx + ' had no audio');
      if (r.stopping && mr === r.mr) cleanupRecording();
    };
    mr.start(5000);
    r.mr = mr;
    r.segTimer = setTimeout(function () { rotate(); }, Math.max(0.05, Number(CFG.segmentMinutes) || 10) * 60000); // never shorter than 3 seconds
  }

  function rotate() {
    var r = S.rec;
    if (!r || r.stopping) return;
    var old = r.mr;
    startSegment();
    try { old.stop(); } catch (e) { logEvt('rotate', e.message); }
  }

  function cleanupRecording() {
    var r = S.rec;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    [r.mic, r.display].forEach(function (s) { if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); });
    try { if (r.ac && r.ac.state !== 'closed') r.ac.close(); } catch (e) { /* ignore */ }
    try { if (r.wl && !r.wl.released) r.wl.release(); } catch (e) { /* ignore */ }
    S.rec = null;
    var btn = $('rzt-rec');
    btn.setAttribute('aria-pressed', 'false');
    $('rzt-rec-label').textContent = 'Start recording';
    btn.style.setProperty('--level', '0');
    setStatus('Recording stopped. Finishing uploads...', 'info');
    updateUi();
    pumpQueue();
  }

  async function startRecording() {
    if (S.rec) return;
    if (!ready()) { updateUi(); return; }
    if (!hasMedia()) { setStatus('This browser cannot record audio. Try Chrome, Edge, Firefox or Safari (see Diagnostics).', 'bad'); return; }
    var wantTab = $('rzt-tab').checked && !$('rzt-tab-wrap').hidden;
    var r = { id: uuid(), nextIdx: 0, stopping: false, src: 'mic', lang: selectedLang(), lastSound: Date.now(), silentWarned: false };
    S.rec = r;
    $('rzt-rec').disabled = true;
    try {
      r.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: !!CFG.echoCancellation, noiseSuppression: !!CFG.noiseSuppression, autoGainControl: !!CFG.autoGainControl } });
    } catch (e) {
      S.rec = null; $('rzt-rec').disabled = false;
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setStatus(denied ? 'The browser blocked the microphone. Allow it in the address bar, then try again.' : 'Could not open the microphone (' + (e && e.name) + '). Another app may be using it.', 'bad');
      logEvt('mic_' + (e && e.name), e && e.message);
      return;
    }
    if (wantTab) {
      try {
        r.display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
        if (r.display.getAudioTracks().length === 0) {
          r.display.getTracks().forEach(function (t) { t.stop(); });
          r.display = null;
          setStatus('No tab sound was shared, so only your microphone is recorded. Next time tick "Also share tab audio".', 'warn');
          logEvt('no_tab_audio', 'display stream had no audio track');
        } else { r.src = 'tab+mic'; }
      } catch (e2) {
        r.display = null;
        logEvt('display_' + (e2 && e2.name), e2 && e2.message);
        setStatus('Tab sharing was cancelled, so only your microphone is recorded.', 'warn');
      }
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        r.ac = new AC();
        if (r.ac.state === 'suspended') { try { await r.ac.resume(); } catch (e3) { /* ignore */ } }
        var micSrc = r.ac.createMediaStreamSource(r.mic);
        r.analyser = r.ac.createAnalyser(); r.analyser.fftSize = 1024;
        r.buf = new Uint8Array(r.analyser.fftSize);
        micSrc.connect(r.analyser);
        if (r.display) {
          var dest = r.ac.createMediaStreamDestination();
          micSrc.connect(dest);
          var tabSrc = r.ac.createMediaStreamSource(new MediaStream(r.display.getAudioTracks()));
          tabSrc.connect(dest); tabSrc.connect(r.analyser);
          r.stream = dest.stream;
        }
      }
    } catch (e4) { logEvt('audiocontext', e4 && e4.message); r.analyser = null; if (r.display) { r.display.getTracks().forEach(function (t) { t.stop(); }); r.display = null; r.src = 'mic'; } }
    if (!r.stream) r.stream = r.mic;

    var mt = r.mic.getAudioTracks()[0];
    if (mt) {
      mt.addEventListener('mute', function () { setStatus('The system muted your microphone. A call or another app may have taken it.', 'warn'); logEvt('mic_muted', ''); });
      mt.addEventListener('unmute', function () { if (S.rec) setStatus('Recording...', 'rec'); });
      mt.addEventListener('ended', function () { if (S.rec && !S.rec.stopping) { logEvt('mic_ended', ''); setStatus('The microphone stopped. Your recording so far is being saved.', 'warn'); stopRecording(); } });
    }
    if (r.display) r.display.getTracks().forEach(function (t) { t.addEventListener('ended', function () { if (S.rec && !S.rec.stopping) setStatus('Tab sharing ended. Still recording your microphone only.', 'warn'); }); });

    startSegment();
    lockScreen();
    r.t0 = Date.now();
    r.timer = setInterval(function () { $('rzt-time').textContent = fmtTime((Date.now() - r.t0) / 1000); }, 250);
    r.raf = requestAnimationFrame(meterLoop);
    var btn = $('rzt-rec');
    btn.disabled = false;
    btn.setAttribute('aria-pressed', 'true');
    $('rzt-rec-label').textContent = 'Stop recording';
    $('rzt-time').textContent = '00:00';
    if (!$('rzt-status').classList.contains('is-warn')) setStatus('Recording...', 'rec');
  }

  function stopRecording() {
    var r = S.rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    clearTimeout(r.segTimer);
    try { r.mr.stop(); } catch (e) { cleanupRecording(); }
  }

  /* ---------- 7. Upload queue ---------- */
  function currentOptions() {
    return { engine: $('rzt-engine').value || 'auto', smart: $('rzt-smart').checked, keep: !$('rzt-keep-wrap').hidden && $('rzt-keep').checked };
  }

  function enqueuePart(p) {
    var o = currentOptions();
    var part = { uid: uuid(), rid: p.rid, idx: p.idx, blob: p.blob, dur: p.dur, src: p.src, lang: p.lang, engine: o.engine, smart: o.smart, keep: o.keep, status: 'queued', text: '', results: [], notes: [], segmentId: null, error: null, dirty: false, attempts: 0, force: false };
    S.parts.push(part);
    renderPart(part);
    pumpQueue();
  }

  async function pumpQueue() {
    if (S.pumping) return;
    S.pumping = true;
    try {
      for (;;) {
        var next = S.parts.filter(function (p) { return p.status === 'queued'; })[0];
        if (!next) break;
        await sendPart(next);
      }
    } finally {
      S.pumping = false;
      if (!S.rec && !S.parts.some(function (p) { return p.status === 'queued' || p.status === 'uploading'; })) {
        var done = S.parts.filter(function (p) { return p.status === 'done'; }).length;
        if (done) setStatus('All parts are transcribed. Check the text, fix mistakes, then press Save corrections.', 'ok');
      }
    }
  }

  async function sendPart(part) {
    part.status = 'uploading'; part.error = null; renderPart(part);
    var q = new URLSearchParams({ rid: part.rid, idx: String(part.idx), lang: part.lang, engine: part.engine, dur: String(Math.round(part.dur)), src: part.src, keep: part.keep ? '1' : '0', mode: part.smart ? 'smart' : 'verbatim' });
    if (part.force) q.set('force', '1');
    var title = $('rzt-title').value.trim();
    if (title) q.set('title', title);
    var type = mimeBase(part.blob.type) || 'audio/webm';
    for (var attempt = 1; attempt <= 3; attempt++) {
      part.attempts = attempt;
      try {
        var data = await api('/api/transcribe?' + q.toString(), { method: 'POST', body: part.blob, headers: { 'Content-Type': type } });
        part.status = 'done'; part.segmentId = data.segmentId; part.text = data.text || ''; part.results = data.results || []; part.notes = data.notes || []; part.cached = !!data.cached; part.force = false;
        renderPart(part); refreshUsage(); loadHistory();
        return;
      } catch (e) {
        if (retryable(e) && attempt < 3) { renderPart(part, 'Network problem, trying again (' + (attempt + 1) + ' of 3)...'); await sleep(1500 * attempt * attempt); continue; }
        part.status = 'error'; part.error = e; part.results = (e.data && e.data.results) || [];
        renderPart(part);
        return;
      }
    }
  }

  /* ---------- 8. Transcript view ---------- */
  var ENGINE_NAMES = { gemini: 'Gemini', whisper: 'Whisper (Cloudflare)' };

  function partTitle(part) { return 'Part ' + (part.idx + 1) + ', ' + fmtTime(part.dur); }

  function renderPart(part, note) {
    var box = $('rzt-parts');
    $('rzt-empty').hidden = true;
    var el = part.el;
    if (!el) {
      el = part.el = {};
      el.root = h('article', { class: 'rzt-part', 'data-uid': part.uid });
      el.head = h('div', { class: 'rzt-part-head' });
      el.state = h('p', { class: 'rzt-part-state', role: 'status' });
      el.ta = h('textarea', { rows: '6', 'aria-label': 'Transcript text for ' + partTitle(part), spellcheck: 'false' });
      el.ta.addEventListener('input', function () { part.dirty = el.ta.value !== part.text; el.save.disabled = !part.dirty; });
      el.save = h('button', { type: 'button', class: 'btn btn-primary rzt-small', text: 'Save corrections', onclick: function () { saveCorrection(part); } });
      el.retry = h('button', { type: 'button', class: 'btn btn-secondary rzt-small', text: 'Retry', onclick: function () { part.status = 'queued'; part.force = true; renderPart(part); pumpQueue(); } });
      el.compare = h('div', { class: 'rzt-compare' });
      el.score = h('button', { type: 'button', class: 'btn btn-secondary rzt-small', text: 'Score engines against my text', onclick: function () { scoreEngines(part); } });
      el.scoreOut = h('p', { class: 'rzt-msg' });
      el.sug = h('div', { class: 'rzt-sug' });
      el.actions = h('div', { class: 'rzt-actions' }, [el.save, el.retry, el.score]);
      el.root.appendChild(el.head); el.root.appendChild(el.state); el.root.appendChild(el.ta); el.root.appendChild(el.actions); el.root.appendChild(el.scoreOut); el.root.appendChild(el.compare); el.root.appendChild(el.sug);
      // keep parts in order
      var inserted = false;
      Array.prototype.forEach.call(box.children, function (c) {
        if (inserted) return;
        var other = S.parts.filter(function (p) { return p.uid === c.getAttribute('data-uid'); })[0];
        if (other && (other.rid === part.rid ? other.idx > part.idx : false)) { box.insertBefore(el.root, c); inserted = true; }
      });
      if (!inserted) box.appendChild(el.root);
    }
    el.head.textContent = '';
    el.head.appendChild(h('span', { text: partTitle(part) }));
    var meta = [];
    if (part.status === 'done') meta.push((ENGINE_NAMES[part.engineUsed || primaryOf(part)] || primaryOf(part) || ''));
    if (part.cached) meta.push('saved result');
    if (part.src === 'tab+mic') meta.push('mic + tab');
    el.head.appendChild(h('span', { class: 'rzt-part-meta', text: meta.filter(Boolean).join(', ') }));

    var stateText = '';
    if (note) stateText = note;
    else if (part.status === 'queued') stateText = 'Waiting to upload...';
    else if (part.status === 'uploading') stateText = 'Uploading and transcribing... ' + (part.attempts > 1 ? '(attempt ' + part.attempts + ')' : '');
    else if (part.status === 'error') stateText = friendlyError(part.error);
    else if (part.notes && part.notes.length) stateText = part.notes.join(' ');
    el.state.textContent = stateText;
    el.state.className = 'rzt-part-state' + (part.status === 'error' ? ' is-bad' : '');

    var showText = part.status === 'done';
    el.ta.hidden = !showText;
    if (showText && !part.dirty && el.ta.value !== part.text) el.ta.value = part.text;
    el.save.hidden = !showText; el.save.disabled = !part.dirty;
    el.retry.hidden = part.status !== 'error';
    var okRuns = (part.results || []).filter(function (r) { return r.ok && r.text; });
    el.score.hidden = !(showText && okRuns.length > 1);
    renderCompare(part);
  }

  function primaryOf(part) {
    var r = (part.results || []).filter(function (x) { return x.ok; })[0];
    return r ? r.engine : '';
  }

  function renderCompare(part) {
    var el = part.el;
    el.compare.textContent = '';
    var runs = part.results || [];
    if (part.status === 'error') {
      runs.forEach(function (r) { if (!r.ok) el.compare.appendChild(h('p', { class: 'rzt-msg is-bad', text: (ENGINE_NAMES[r.engine] || r.engine) + ': ' + (r.error || 'failed') })); });
      return;
    }
    if (runs.length < 2) {
      runs.filter(function (r) { return !r.ok; }).forEach(function (r) { el.compare.appendChild(h('p', { class: 'rzt-msg is-warn', text: (ENGINE_NAMES[r.engine] || r.engine) + ' did not work, so the other engine was used: ' + (r.error || '') })); });
      return;
    }
    runs.forEach(function (r) {
      var d = h('details', { class: 'rzt-engine-run' });
      var sum = (ENGINE_NAMES[r.engine] || r.engine) + (r.ok ? '' : ' (failed)') + (r.ms ? ', ' + (r.ms / 1000).toFixed(1) + ' s' : '') + (typeof r.wer === 'number' ? ', error rate ' + (r.wer * 100).toFixed(1) + '%' : '');
      d.appendChild(h('summary', { text: sum }));
      if (r.ok) {
        d.appendChild(h('p', { class: 'rzt-engine-text', text: r.text }));
        d.appendChild(h('button', { type: 'button', class: 'btn btn-secondary rzt-small', text: 'Use this text', onclick: function () { part.el.ta.value = r.text; part.dirty = part.el.ta.value !== part.text; part.el.save.disabled = !part.dirty; } }));
      } else d.appendChild(h('p', { class: 'rzt-msg is-bad', text: r.error || 'failed' }));
      el.compare.appendChild(d);
    });
  }

  async function saveCorrection(part) {
    var el = part.el, after = el.ta.value, before = part.text;
    if (after === before) { el.save.disabled = true; return; }
    el.save.disabled = true;
    try {
      var d = diffWords(before, after);
      var r = await api('/api/corrections', { method: 'POST', json: { segmentId: part.segmentId, after: after, pairs: d.pairs, newWords: d.newWords } });
      part.text = after; part.dirty = false;
      renderPart(part, 'Saved.');
      showSuggestions(part, r.suggestions || {});
      loadRules();
    } catch (e) { el.save.disabled = false; renderPart(part, friendlyError(e)); }
  }

  function showSuggestions(part, sug) {
    var box = part.el.sug;
    box.textContent = '';
    var lex = (langInfo(part.lang) && langInfo(part.lang).lexicons[0]) || 'ms-sarawak';
    if (sug.newWords && sug.newWords.length) {
      box.appendChild(h('p', { class: 'rzt-msg', text: 'New words you typed. Tap one to add it to the word list:' }));
      var row = h('div', { class: 'rzt-chips' });
      sug.newWords.forEach(function (w) {
        var b = h('button', { type: 'button', class: 'rzt-chip rzt-chip-btn', text: '+ ' + w });
        b.addEventListener('click', async function () {
          b.disabled = true;
          try { await api('/api/lexicon', { method: 'POST', json: { items: [{ language: lex, term: w, source: 'my correction' }] } }); b.textContent = 'Added: ' + w; loadLexicon(); }
          catch (e) { b.disabled = false; b.textContent = friendlyError(e); }
        });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    if (sug.rules && sug.rules.length) {
      box.appendChild(h('p', { class: 'rzt-msg is-ok', text: 'Repeated fix ready for approval: ' + sug.rules.map(function (r) { return '"' + r.wrong + '" to "' + r.right + '" (seen ' + r.seen + ' times)'; }).join('; ') + '. Approve it under Suggested fixes.' }));
    }
  }

  async function scoreEngines(part) {
    var el = part.el;
    var ref = el.ta.value;
    var runs = (part.results || []).filter(function (r) { return r.ok && r.text; });
    if (tokens(ref).length < 5) { el.scoreOut.textContent = 'Type the correct text first (at least 5 words), then score.'; el.scoreOut.className = 'rzt-msg is-warn'; return; }
    try {
      if (part.dirty) await saveCorrection(part);
      var scores = {}, lines = [];
      runs.forEach(function (r) { var s = wer(ref, r.text); scores[r.engine] = { wer: s.wer, refWords: s.refWords }; r.wer = s.wer; lines.push((ENGINE_NAMES[r.engine] || r.engine) + ': ' + (s.wer * 100).toFixed(1) + '% (' + s.errors + ' word errors in ' + s.refWords + ')'); });
      await api('/api/score', { method: 'POST', json: { segmentId: part.segmentId, scores: scores } });
      el.scoreOut.textContent = 'Error rate against your text. ' + lines.join('. ') + '. Lower is better.';
      el.scoreOut.className = 'rzt-msg is-ok';
      renderCompare(part);
    } catch (e) { el.scoreOut.textContent = friendlyError(e); el.scoreOut.className = 'rzt-msg is-bad'; }
  }

  function allText() { return buildTxt(S.parts.filter(function (p) { return p.status === 'done'; }).map(function (p) { return { idx: p.idx, dur: p.dur, text: p.el ? p.el.ta.value : p.text }; }), { language: (langInfo(selectedLang()) || {}).label, date: new Date().toISOString().slice(0, 10) }); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      try { var ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch (e2) { return false; }
    }
  }
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------- 9. Upload a file ---------- */
  async function onFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f || !ready()) return;
    var max = CFG.maxUploadMB * 1024 * 1024;
    if (S.cfg && S.cfg.limits) max = Math.min(max, S.cfg.limits.maxUploadMB * 1024 * 1024);
    if (f.size > max) { setStatus('That file is ' + (f.size / 1048576).toFixed(1) + ' MB. The limit is ' + Math.round(max / 1048576) + ' MB per file. Trim it or save it at a lower quality.', 'bad'); return; }
    var type = mimeFromName(f.name, f.type);
    if (!type) { setStatus('That file type is not recognised. Use mp3, m4a, wav, webm, ogg, flac or aac.', 'bad'); return; }
    var dur = await audioDuration(f);
    var rid = uuid();
    setStatus('Uploading ' + f.name + '...', 'info');
    var blob = f.slice(0, f.size, type);
    enqueuePart({ blob: blob, idx: 0, dur: dur || Math.max(1, f.size / 16000), rid: rid, src: 'upload', lang: selectedLang() });
  }

  function audioDuration(file) {
    return new Promise(function (resolve) {
      try {
        var url = URL.createObjectURL(file), a = new Audio();
        var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
        a.preload = 'metadata';
        a.onloadedmetadata = function () { done(isFinite(a.duration) ? a.duration : 0); };
        a.onerror = function () { done(0); };
        setTimeout(function () { done(0); }, 4000);
        a.src = url;
      } catch (e) { resolve(0); }
    });
  }

  /* ---------- 10. Word list, fixes, history, usage ---------- */
  function adminNote(e) { return e && e.code === 'admin_required' ? 'This needs the admin code. Enter it under Set up, press Connect, then try again.' : friendlyError(e); }

  async function loadLexicon() {
    if (!S.cfg) return;
    var lang = $('rzt-lex-lang').value;
    try {
      var r = await api('/api/lexicon?lang=' + encodeURIComponent(lang) + '&limit=300');
      var tb = $('rzt-lex-list');
      tb.textContent = '';
      (r.terms || []).forEach(function (t) {
        var tr = h('tr', {}, [
          h('td', { text: t.term }), h('td', { text: t.meaning || '' }),
          h('td', { text: t.status }),
          h('td', {}, [
            h('button', { type: 'button', class: 'rzt-link', text: t.status === 'verified' ? 'Unverify' : 'Verify', onclick: async function () { try { await api('/api/lexicon/' + t.id, { method: 'PATCH', admin: true, json: { status: t.status === 'verified' ? 'unverified' : 'verified' } }); loadLexicon(); } catch (e) { setMsg('rzt-lex-msg', adminNote(e), 'bad'); } } }),
            ' ',
            h('button', { type: 'button', class: 'rzt-link', text: 'Delete', onclick: async function () { try { await api('/api/lexicon/' + t.id, { method: 'DELETE', admin: true }); loadLexicon(); } catch (e) { setMsg('rzt-lex-msg', adminNote(e), 'bad'); } } })
          ])
        ]);
        tb.appendChild(tr);
      });
      $('rzt-lex-empty').hidden = (r.terms || []).length > 0;
      var total = (r.counts || []).reduce(function (a, c) { return a + c.n; }, 0);
      $('rzt-lex-count').textContent = total + ' words saved in total. The first ' + r.biasMax + ' for each language are sent to the engine with every recording (verified words first).';
    } catch (e) { setMsg('rzt-lex-msg', friendlyError(e), 'bad'); }
  }

  async function addLexicon() {
    var term = $('rzt-lex-term').value.trim();
    if (!term) { setMsg('rzt-lex-msg', 'Type a word first.', 'warn'); return; }
    try {
      await api('/api/lexicon', { method: 'POST', json: { items: [{ language: $('rzt-lex-lang').value, term: term, meaning: $('rzt-lex-meaning').value.trim(), source: 'typed in page' }] } });
      $('rzt-lex-term').value = ''; $('rzt-lex-meaning').value = '';
      setMsg('rzt-lex-msg', 'Added.', 'ok'); loadLexicon();
    } catch (e) { setMsg('rzt-lex-msg', friendlyError(e), 'bad'); }
  }

  async function importLexicon(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      var items = lexiconFromCsv(await f.text());
      if (!items.length) { setMsg('rzt-lex-msg', 'No words found in that file (the example row is skipped).', 'warn'); return; }
      var saved = 0, skipped = 0;
      for (var i = 0; i < items.length; i += 400) {
        var r = await api('/api/lexicon', { method: 'POST', json: { items: items.slice(i, i + 400) } });
        saved += r.saved; skipped += r.skipped;
      }
      setMsg('rzt-lex-msg', 'Imported ' + saved + ' words' + (skipped ? ' (' + skipped + ' skipped: unknown language or empty word)' : '') + '.', 'ok');
      loadLexicon();
    } catch (e) { setMsg('rzt-lex-msg', friendlyError(e), 'bad'); }
  }

  function csvTemplate() {
    download('Reysourcez-Transcriber-lexicon-template_v0.2.csv', 'language,term,meaning,variants,source\r\nms-sarawak,EXAMPLE_TERM,replace this row with a real word,,where you found it\r\n');
  }

  async function loadRules() {
    if (!S.cfg) return;
    try {
      var r = await api('/api/rules');
      var box = $('rzt-rules-list');
      box.textContent = '';
      (r.rules || []).forEach(function (x) {
        box.appendChild(h('li', {}, [
          h('span', { text: '"' + x.wrong + '" to "' + x.right + '" (' + (LEX_LABELS[x.language] || x.language) + ', seen ' + x.seen + ' times) ' }),
          h('button', { type: 'button', class: 'rzt-link', text: 'Approve', onclick: async function () { try { await api('/api/rules/' + x.id + '/approve', { method: 'POST', admin: true }); loadRules(); } catch (e) { setMsg('rzt-rules-msg', adminNote(e), 'bad'); } } }),
          ' ',
          h('button', { type: 'button', class: 'rzt-link', text: 'Remove', onclick: async function () { try { await api('/api/rules/' + x.id, { method: 'DELETE', admin: true }); loadRules(); } catch (e) { setMsg('rzt-rules-msg', adminNote(e), 'bad'); } } })
        ]));
      });
      $('rzt-rules-empty').hidden = (r.rules || []).length > 0;
    } catch (e) { setMsg('rzt-rules-msg', friendlyError(e), 'bad'); }
  }

  async function loadHistory() {
    if (!S.cfg) return;
    try {
      var r = await api('/api/recordings?limit=15');
      var box = $('rzt-hist-list');
      box.textContent = '';
      (r.recordings || []).forEach(function (x) {
        box.appendChild(h('li', {}, [
          h('span', { text: (x.title || 'Untitled') + ', ' + String(x.created_at).slice(0, 16).replace('T', ' ') + ', ' + x.parts + ' part(s), ' + fmtTime(x.secs) + ' ' }),
          h('button', { type: 'button', class: 'rzt-link', text: 'Open', onclick: function () { openRecording(x.id); } }),
          ' ',
          h('button', { type: 'button', class: 'rzt-link', text: 'Delete', onclick: async function () {
            if (!window.confirm('Delete this recording, its text and any saved audio? This cannot be undone.')) return;
            try { await api('/api/recordings/' + x.id, { method: 'DELETE' }); loadHistory(); } catch (e) { setMsg('rzt-hist-msg', friendlyError(e), 'bad'); }
          } })
        ]));
      });
      $('rzt-hist-empty').hidden = (r.recordings || []).length > 0;
    } catch (e) { setMsg('rzt-hist-msg', friendlyError(e), 'bad'); }
  }

  async function openRecording(id) {
    try {
      var r = await api('/api/recordings/' + id);
      $('rzt-parts').textContent = '';
      S.parts = [];
      (r.segments || []).forEach(function (s) {
        var part = { uid: uuid(), rid: id, idx: s.idx, blob: null, dur: s.durationSec || 0, src: r.recording.source, lang: r.recording.language, status: 'done', text: s.text || '', results: s.runs || [], notes: [], segmentId: s.id, dirty: false, cached: true };
        S.parts.push(part);
        renderPart(part);
      });
      $('rzt-empty').hidden = S.parts.length > 0;
      setStatus('Opened "' + (r.recording.title || 'Untitled') + '".', 'info');
      window.scrollTo({ top: $('rzt-transcript-card').offsetTop - 80, behavior: 'smooth' });
    } catch (e) { setMsg('rzt-hist-msg', friendlyError(e), 'bad'); }
  }

  async function refreshUsage() {
    if (!S.cfg) return;
    try {
      var u = await api('/api/usage');
      $('rzt-usage-out').textContent = 'This device today: ' + u.device.minutesToday.toFixed(1) + ' of ' + u.device.dailyMin + ' minutes. Whole site this month: ' + u.site.minutesMonth.toFixed(1) + ' minutes, about US$' + u.site.costMonthUsd.toFixed(3) + ' of the US$' + u.site.capUsd + ' cap. ' + u.note;
    } catch (e) { $('rzt-usage-out').textContent = friendlyError(e); }
  }

  /* ---------- 11. Diagnostics ---------- */
  async function runDiagnostics() {
    var out = [], ok = '[ok]  ', bad = '[FIX] ', info = '[info] ';
    function line(good, text) { out.push((good === null ? info : good ? ok : bad) + text); }
    line(null, 'Voice Transcriber page v' + CFG.version + ', ' + new Date().toISOString());
    line(null, 'Page address: ' + location.origin + ' | Browser: ' + UA.slice(0, 120));
    line(window.isSecureContext, 'Secure page (https or localhost): ' + window.isSecureContext + (window.isSecureContext ? '' : '. Recording only works on https pages.'));
    line(typeof MediaRecorder !== 'undefined', 'MediaRecorder available: ' + (typeof MediaRecorder !== 'undefined'));
    line(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), 'Microphone access API: ' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    if (typeof MediaRecorder !== 'undefined') {
      line(null, 'Recording formats this browser can make: ' + (MIME_CANDIDATES.filter(function (m) { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }).join(', ') || 'none'));
      line(!!pickMime(function (m) { return MediaRecorder.isTypeSupported(m); }), 'A usable format was found');
    }
    line(null, 'Meeting-tab sound (desktop Chrome/Edge only): ' + (!!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !IS_MOBILE ? 'available' : 'not available here'));
    line(null, 'Keep-screen-on (Wake Lock): ' + ('wakeLock' in navigator ? 'available' : 'not available'));
    try { var p = await navigator.permissions.query({ name: 'microphone' }); line(p.state !== 'denied', 'Microphone permission: ' + p.state); } catch (e) { line(null, 'Microphone permission: cannot be read in this browser'); }
    line(null, 'Device type: ' + (IS_IOS ? 'iPhone/iPad' : IS_MOBILE ? 'Android' : 'computer'));
    line(apiConfigured(), 'Worker address set: ' + (apiConfigured() ? apiBase() : 'NO - set transcriber.apiBase in site-config.js'));
    if (apiConfigured()) {
      try {
        var res = await fetch(apiBase() + '/api/health');
        var hd = await res.json();
        line(hd.ok, 'Worker health: ' + (hd.ok ? 'OK' : 'needs setup') + ' (v' + hd.version + ')');
        Object.keys(hd.checks || {}).forEach(function (k) { out.push('       ' + k + ': ' + hd.checks[k]); });
        (hd.hints || []).forEach(function (t) { out.push(bad + t); });
      } catch (e2) { line(false, 'Could not reach the Worker health page: ' + (e2 && e2.message) + '. Check the address, and that ALLOWED_ORIGINS includes ' + location.origin); }
      if (S.access) {
        try { var c = await api('/api/config'); line(true, 'Access code accepted; consent saved: ' + (c.consent && c.consent.processing && c.consent.participants)); line(c.engines.gemini || c.engines.whisper, 'At least one speech engine on (Gemini ' + c.engines.gemini + ', Whisper ' + c.engines.whisper + ')'); }
        catch (e3) { line(false, 'Access check failed: ' + friendlyError(e3)); }
      } else line(false, 'No access code entered yet.');
    }
    out.push('', 'Recent page events (' + S.log.length + '):');
    S.log.slice(-20).forEach(function (l) { out.push('  ' + l.t.slice(11, 19) + ' ' + l.code + ' ' + l.message); });
    $('rzt-diag-out').textContent = out.join('\n');
  }

  /* ---------- 12. Wire up ---------- */
  function init() {
    S.clientId = sget('rzt_client') || uuid();
    sset('rzt_client', S.clientId, true);
    var rem = store('local') && store('local').getItem('rzt_remember') !== '0';
    $('rzt-remember').checked = rem !== false;
    S.access = sget('rzt_access'); S.admin = sget('rzt_admin');
    $('rzt-access').value = S.access; $('rzt-admin').value = S.admin;
    $('rzt-year').textContent = new Date().getFullYear();
    $('rzt-engine').value = CFG.defaultEngine;
    $('rzt-ios-note').hidden = !IS_IOS;
    $('rzt-lang').appendChild(h('option', { value: CFG.defaultLanguage, text: 'Loading languages...' }));
    renderConn(); renderConsent(); updateUi();

    $('rzt-connect').addEventListener('click', connect);
    $('rzt-access').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
    $('rzt-c-save').addEventListener('click', saveConsent);
    $('rzt-rec').addEventListener('click', function () { if (S.rec) stopRecording(); else startRecording(); });
    $('rzt-lang').addEventListener('change', function () { S.lastLang = selectedLang(); var li = langInfo(selectedLang()); if (li) $('rzt-lex-lang').value = li.lexicons[0]; updateUi(); loadLexicon(); });
    $('rzt-file').addEventListener('change', onFile);
    $('rzt-copy').addEventListener('click', async function () { var ok = await copyText(allText()); setStatus(ok ? 'Copied the transcript.' : 'Copy was blocked. Use Download instead.', ok ? 'ok' : 'warn'); });
    $('rzt-download').addEventListener('click', function () { download('transcript-' + new Date().toISOString().slice(0, 10) + '.txt', allText()); });
    $('rzt-clear').addEventListener('click', function () { if (S.parts.some(function (p) { return p.dirty; }) && !window.confirm('Some edits are not saved. Clear the view anyway?')) return; S.parts = S.parts.filter(function (p) { return p.status === 'queued' || p.status === 'uploading'; }); $('rzt-parts').textContent = ''; S.parts.forEach(function (p) { p.el = null; renderPart(p); }); $('rzt-empty').hidden = S.parts.length > 0; });
    $('rzt-lex-add').addEventListener('click', addLexicon);
    $('rzt-lex-lang').addEventListener('change', loadLexicon);
    $('rzt-lex-file').addEventListener('change', importLexicon);
    $('rzt-lex-template').addEventListener('click', csvTemplate);
    $('rzt-rules-refresh').addEventListener('click', loadRules);
    $('rzt-hist-refresh').addEventListener('click', loadHistory);
    $('rzt-usage-refresh').addEventListener('click', refreshUsage);
    $('rzt-diag-run').addEventListener('click', runDiagnostics);
    $('rzt-diag-copy').addEventListener('click', async function () { var ok = await copyText($('rzt-diag-out').textContent); setMsg('rzt-diag-msg', ok ? 'Report copied. Paste it to whoever is helping you.' : 'Copy was blocked. Select the text and copy it by hand.', ok ? 'ok' : 'warn'); });
    window.addEventListener('beforeunload', function (e) {
      if (S.rec || S.parts.some(function (p) { return p.status === 'queued' || p.status === 'uploading' || p.dirty; })) { e.preventDefault(); e.returnValue = ''; }
    });
    if (S.access && apiConfigured()) connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
