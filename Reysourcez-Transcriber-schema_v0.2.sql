-- Reysourcez Voice Transcriber - database tables
-- VERSION 0.2 | file: Reysourcez-Transcriber-schema_v0.2.sql | 2026-10-08
--
-- You normally do NOT need to run this. The Worker creates these tables by itself
-- the first time it is used. This file is for reference, or if you ever want to set the
-- database up by hand: Cloudflare dashboard > Storage & databases > D1 > your database > Console,
-- paste everything below, press Execute.
-- Generated from the same list the Worker uses (SCHEMA in Reysourcez-Transcriber-worker_v0.2.js).

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT NOT NULL, title TEXT, language TEXT, source TEXT, keep_audio INTEGER NOT NULL DEFAULT 0, consent_version TEXT);

CREATE INDEX IF NOT EXISTS idx_recordings_client ON recordings(client_id, created_at);

CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, idx INTEGER NOT NULL, created_at TEXT NOT NULL, duration_sec REAL, mime TEXT, bytes INTEGER, r2_key TEXT, text_raw TEXT, text_final TEXT, engine TEXT, lang_detected TEXT, UNIQUE(recording_id, idx));

CREATE TABLE IF NOT EXISTS engine_runs (id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, engine TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER, est_cost_usd REAL, text TEXT, error TEXT, created_at TEXT NOT NULL, wer REAL, ref_words INTEGER);

CREATE INDEX IF NOT EXISTS idx_runs_segment ON engine_runs(segment_id);

CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, client_id TEXT NOT NULL, language TEXT, before_text TEXT, after_text TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS lexicon_terms (id TEXT PRIMARY KEY, language TEXT NOT NULL, term TEXT NOT NULL, meaning TEXT, variants TEXT, source TEXT, status TEXT NOT NULL DEFAULT 'unverified', created_at TEXT NOT NULL, created_by TEXT, UNIQUE(language, term));

CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, language TEXT NOT NULL, wrong TEXT NOT NULL, right TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(language, wrong, right));

CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, client_id TEXT NOT NULL, engine TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, client_id, engine));

CREATE TABLE IF NOT EXISTS consent_log (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, version TEXT NOT NULL, granted INTEGER NOT NULL, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_consent_client ON consent_log(client_id, version, scope, created_at);

CREATE TABLE IF NOT EXISTS auth_fail (ip_hash TEXT NOT NULL, hour TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, hour));

CREATE TABLE IF NOT EXISTS error_log (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, route TEXT, code TEXT, message TEXT, detail TEXT);

INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1');
