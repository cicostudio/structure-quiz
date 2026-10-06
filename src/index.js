// 結構認證路徑測驗｜Cloudflare Worker（API）+ D1
// 靜態頁面（測驗、後台）由 Workers Static Assets 從 ./public 提供；這支 Worker 只處理 /api/*
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = new Hono();

const CONSENT_VERSION = '2026-10-v1';
const MAX_BODY = 64 * 1024;
const MAX_EVENTS_PER_CALL = 60;
const MAX_EVENTS_PER_SESSION = 1500;
const STATUS_BY_STAGE = ['opened', 'in_progress', 'completed', 'gate_viewed', 'lead_submitted'];

/* ---------- 小工具 ---------- */
const now = () => new Date().toISOString();
const str = (v, max = 200) => (v === undefined || v === null || v === '') ? null : String(v).slice(0, max);
const int = (v, lo = 0, hi = 1e9) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const json = (v, max = 16000) => { if (v === undefined || v === null) return null; const s = JSON.stringify(v); return s.length > max ? null : s; };

function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readBody(c) {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, 'body_too_large');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json'); }
}
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code }, err.status);
  console.error(err);
  return c.json({ error: 'server_error' }, 500);
});

/* LINE ID Token 一律在後端向 LINE 驗證，前端傳來的 userId 一律不採信 */
async function verifyIdToken(idToken, channelId) {
  if (!idToken || !channelId) return null;
  try {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId })
    });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.sub ? p : null;
  } catch { return null; }
}

/* 每次作答的寫入憑證：start 時發給前端，資料庫只存雜湊 */
async function auth(c, id, bodyToken) {
  const token = c.req.header('x-session-token') || bodyToken;
  if (!token || !id) throw new HttpError(401, 'no_token');
  const row = await c.env.DB.prepare('SELECT id, token_hash, stage, login_uid FROM quiz_sessions WHERE id = ?').bind(id).first();
  if (!row || !safeEqual(row.token_hash, await sha256hex(token))) throw new HttpError(403, 'bad_token');
  return row;
}

/* ---------- 公開設定 ---------- */
app.get('/api/config', c => c.json({
  liffId: c.env.LIFF_ID || '',
  trial: c.env.TRIAL_MODE === '1',
  oaBasicId: c.env.OA_BASIC_ID || '',
  privacyUrl: c.env.PRIVACY_URL || '',
  consentVersion: CONSENT_VERSION
}));

/* ---------- 一打開就建立紀錄 ---------- */
app.post('/api/session/start', async c => {
  const b = await readBody(c);
  const env = b.env || {}, src = b.source || {};
  const profile = await verifyIdToken(str(b.idToken, 4000), c.env.LINE_LOGIN_CHANNEL_ID);
  const uid = profile ? profile.sub : null;
  const anon = str(b.anonId, 64);

  const id = crypto.randomUUID();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();

  // 第幾次打開、有沒有可以接續的未完成作答（7 天內、答過至少一題）
  let visitNo = 1, resume = null;
  if (uid || anon) {
    const who = uid ? ['login_uid = ?', uid] : ['anon_id = ? AND login_uid IS NULL', anon];
    const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM quiz_sessions WHERE ${who[0]}`).bind(who[1]).first();
    visitNo = (cnt?.n || 0) + 1;
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const r = await c.env.DB.prepare(
      `SELECT id, last_q, answers_json, q_times_json FROM quiz_sessions
       WHERE ${who[0]} AND stage = 1 AND last_q > 0 AND resumed_by IS NULL AND started_at > ?
       ORDER BY last_seen_at DESC LIMIT 1`).bind(who[1], since).first();
    if (r) resume = { id: r.id, lastQ: r.last_q, answers: JSON.parse(r.answers_json || '{}'), qTimes: JSON.parse(r.q_times_json || '{}') };
  }

  await c.env.DB.prepare(`INSERT INTO quiz_sessions (
      id, token_hash, login_uid, display_name, picture_url, email, anon_id, id_verified,
      current_screen, utm_source, utm_medium, utm_campaign, utm_content, utm_term, ref, entry, click_ids_json, landing_url, referrer,
      context_type, view_type, is_in_client, os, language, line_version, user_agent, timezone, screen,
      visit_no, is_trial, started_at, updated_at, last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?)`).bind(
    id, await sha256hex(token), uid, str(profile?.name, 120), str(profile?.picture, 500), str(profile?.email, 200), anon, profile ? 1 : 0,
    'intro', str(src.utm_source), str(src.utm_medium), str(src.utm_campaign), str(src.utm_content), str(src.utm_term),
    str(src.ref, 60), str(src.entry, 60), json(src.clickIds, 1000), str(src.landingUrl, 1000), str(src.referrer, 1000),
    str(env.contextType, 30), str(env.viewType, 30), env.isInClient === undefined ? null : (env.isInClient ? 1 : 0),
    str(env.os, 20), str(env.language, 20), str(env.lineVersion, 30), str(env.userAgent, 400), str(env.timezone, 60), str(env.screen, 30),
    visitNo, b.trial ? 1 : 0, t, t, t
  ).run();
  await c.env.DB.prepare('INSERT INTO quiz_events (session_id, type, payload_json, at) VALUES (?,?,?,?)')
    .bind(id, 'open', json({ verified: !!profile, visitNo }), t).run();

  return c.json({
    sessionId: id, token, visitNo, resume,
    profile: profile ? { name: profile.name || '', picture: profile.picture || '' } : null
  });
});

/* ---------- 進度快照（每答一題、每換一個畫面） ---------- */
async function applyProgress(c, row, p) {
  if (!p || typeof p !== 'object') return;
  const stage = Math.max(row.stage, int(p.stage, 0, 4) ?? 0);
  const t = now();
  const res = p.result || null;
  await c.env.DB.prepare(`UPDATE quiz_sessions SET
      stage = ?, status = ?, last_q = MAX(last_q, ?), current_screen = COALESCE(?, current_screen),
      answers_json = COALESCE(?, answers_json), q_times_json = COALESCE(?, q_times_json),
      backs = MAX(backs, ?), changes = MAX(changes, ?),
      result_type = COALESCE(?, result_type), course = COALESCE(?, course), plan = COALESCE(?, plan),
      high_intent = MAX(high_intent, ?), q10_pref = COALESCE(?, q10_pref), result_json = COALESCE(?, result_json),
      gate_action = COALESCE(gate_action, ?), result_depth = COALESCE(?, result_depth), cta_clicks = MAX(cta_clicks, ?),
      resumed_from = COALESCE(resumed_from, ?),
      first_answer_at = CASE WHEN first_answer_at IS NULL AND ? >= 1 THEN ? ELSE first_answer_at END,
      completed_at = CASE WHEN completed_at IS NULL AND ? >= 2 THEN ? ELSE completed_at END,
      updated_at = ?, last_seen_at = ?
    WHERE id = ?`).bind(
    stage, STATUS_BY_STAGE[stage], int(p.lastQ, 0, 10) ?? 0, str(p.screen, 30),
    json(p.answers, 8000), json(p.qTimes, 4000), int(p.backs, 0, 999) ?? 0, int(p.changes, 0, 999) ?? 0,
    str(res?.type, 4), str(res?.course, 30), str(res?.plan, 60),
    res?.highIntent ? 1 : 0, str(p.q10Pref, 120), json(res, 8000),
    str(p.gateAction, 10), str(p.resultDepth, 20), int(p.ctaClicks, 0, 999) ?? 0,
    str(p.resumedFrom, 40),
    int(p.lastQ, 0, 10) ?? 0, t, stage, t, t, t, row.id
  ).run();
  if (p.resumedFrom) {
    // 接續舊紀錄：舊的那筆標記為已被接續，不算跳出
    await c.env.DB.prepare(`UPDATE quiz_sessions SET resumed_by = ? WHERE id = ? AND resumed_by IS NULL
        AND ((login_uid IS NOT NULL AND login_uid = ?) OR (login_uid IS NULL AND anon_id = (SELECT anon_id FROM quiz_sessions WHERE id = ?)))`)
      .bind(row.id, str(p.resumedFrom, 40), row.login_uid, row.id).run();
  }
}

app.post('/api/session/:id/progress', async c => {
  const b = await readBody(c);
  const row = await auth(c, c.req.param('id'), b.token);
  await applyProgress(c, row, b);
  return c.json({ ok: true });
});

/* ---------- 行為事件（可搭配 sendBeacon，離開頁面時一起送出最後進度） ---------- */
app.post('/api/session/:id/events', async c => {
  const b = await readBody(c);
  const row = await auth(c, c.req.param('id'), b.token);
  const evs = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS_PER_CALL) : [];
  if (evs.length) {
    const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM quiz_events WHERE session_id = ?').bind(row.id).first();
    const room = MAX_EVENTS_PER_SESSION - (cnt?.n || 0);
    const t = now();
    const stmts = evs.slice(0, Math.max(0, room)).map(e => c.env.DB
      .prepare('INSERT INTO quiz_events (session_id, type, q, payload_json, at) VALUES (?,?,?,?,?)')
      .bind(row.id, str(e.type, 30) || 'unknown', str(e.q, 10), json(e.payload, 2000), str(e.at, 30) || t));
    if (stmts.length) await c.env.DB.batch(stmts);
  }
  if (b.progress) await applyProgress(c, row, b.progress);
  else await c.env.DB.prepare('UPDATE quiz_sessions SET last_seen_at = ? WHERE id = ?').bind(now(), row.id).run();
  return c.json({ ok: true });
});

/* ---------- 留資料（只在按下送出時存） ---------- */
app.post('/api/session/:id/lead', async c => {
  const b = await readBody(c);
  const row = await auth(c, c.req.param('id'), b.token);
  const name = str(b.name, 60), email = str(b.email, 200);
  const phone = (str(b.phone, 30) || '').replace(/[-\s]/g, '');
  if (!name || !/^09\d{8}$/.test(phone) || !email || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'invalid_lead');
  if (b.consent !== true) throw new HttpError(400, 'no_consent');
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO leads (session_id, login_uid, name, phone, email, consent_version, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(row.id, row.login_uid, name, phone, email, CONSENT_VERSION, t),
    c.env.DB.prepare(`UPDATE quiz_sessions SET stage = 4, status = 'lead_submitted', gate_action = COALESCE(gate_action, 'submit'),
        lead_at = ?, updated_at = ?, last_seen_at = ? WHERE id = ?`).bind(t, t, t, row.id),
    c.env.DB.prepare('INSERT INTO quiz_events (session_id, type, at) VALUES (?,?,?)').bind(row.id, 'lead_submit', t)
  ]);
  return c.json({ ok: true });
});

/* ---------- 教練試填回饋 ---------- */
app.post('/api/session/:id/feedback', async c => {
  const b = await readBody(c);
  const row = await auth(c, c.req.param('id'), b.token);
  const acc = str(b.accuracy, 10);
  if (!['準確', '部分準確', '不準確'].includes(acc)) throw new HttpError(400, 'invalid_feedback');
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO feedback (session_id, tester, accuracy, expected, comment, created_at) VALUES (?,?,?,?,?,?)')
      .bind(row.id, str(b.tester, 40), acc, str(b.expected, 20), str(b.comment, 1500), t),
    c.env.DB.prepare('UPDATE quiz_sessions SET is_trial = 1 WHERE id = ?').bind(row.id)
  ]);
  return c.json({ ok: true });
});

/* ================= 後台（Cloudflare Access 保護；本機開發用 ADMIN_TOKEN） ================= */
let jwks = null;
async function requireAdmin(c, next) {
  const team = c.env.ACCESS_TEAM_DOMAIN, aud = c.env.ACCESS_AUD;
  if (team && aud) {
    const jwt = c.req.header('cf-access-jwt-assertion');
    if (!jwt) return c.json({ error: 'unauthorized' }, 401);
    try {
      jwks ||= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      await jwtVerify(jwt, jwks, { issuer: `https://${team}`, audience: aud });
      return next();
    } catch { return c.json({ error: 'unauthorized' }, 401); }
  }
  const want = c.env.ADMIN_TOKEN;
  const got = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (want && safeEqual(got, want)) return next();
  return c.json({ error: want ? 'unauthorized' : 'admin_not_configured' }, want ? 401 : 503);
}
app.use('/api/admin/*', requireAdmin);

function rangeFilter(c) {
  const days = int(c.req.query('days'), 1, 365) ?? 30;
  const trial = c.req.query('trial') || 'all';
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const trialSql = trial === 'real' ? ' AND is_trial = 0' : trial === 'trial' ? ' AND is_trial = 1' : '';
  return { days, since, trialSql };
}

const ACTIVE_MS = 30 * 60e3; // 30 分鐘內還有動靜的不算跳出

app.get('/api/admin/summary', async c => {
  const { days, since, trialSql } = rangeFilter(c);
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, stage, last_q, current_screen, q_times_json, gate_action, result_depth, course, high_intent,
            utm_source, entry, ref, context_type, os, is_in_client, id_verified, resumed_by, started_at, last_seen_at, completed_at
     FROM quiz_sessions WHERE started_at > ?${trialSql} ORDER BY started_at DESC LIMIT 10000`).bind(since).all();

  const nowMs = Date.now();
  const live = rows.filter(r => !r.resumed_by);
  const settled = live.filter(r => nowMs - Date.parse(r.last_seen_at) > ACTIVE_MS);
  const n = k => live.filter(k).length;

  const funnel = {
    opened: live.length,
    started: n(r => r.stage >= 1),
    completed: n(r => r.stage >= 2),
    gateViewed: n(r => r.stage >= 3),
    lead: n(r => r.stage >= 4),
    skipped: n(r => r.gate_action === 'skip'),
    line: n(r => r.gate_action === 'line'),
    identified: n(r => r.id_verified === 1)
  };

  // 每一題：看到幾人、答完幾人、停在這題離開幾人、平均／中位作答秒數
  const questions = [];
  for (let q = 1; q <= 10; q++) {
    const reached = live.filter(r => r.stage >= 1 && r.last_q >= q - 1).length;
    const answered = live.filter(r => r.last_q >= q).length;
    const droppedHere = settled.filter(r => r.stage === 1 && r.last_q === q - 1).length;
    const times = [];
    for (const r of live) { try { const t = JSON.parse(r.q_times_json || '{}')['q' + q]; if (t > 0 && t < 600000) times.push(t); } catch {} }
    times.sort((a, b) => a - b);
    const med = times.length ? times[Math.floor(times.length / 2)] : null;
    const avg = times.length ? times.reduce((s, x) => s + x, 0) / times.length : null;
    questions.push({ q, reached, answered, droppedHere, medianSec: med && Math.round(med / 100) / 10, avgSec: avg && Math.round(avg / 100) / 10 });
  }
  const dropIntro = settled.filter(r => r.stage === 0).length;
  const dropGate = settled.filter(r => r.stage === 3 && !r.gate_action).length;
  const dropResult = settled.filter(r => r.stage === 2 && r.current_screen === 'result').length;

  const group = (key) => {
    const m = new Map();
    for (const r of live) {
      const k = key(r) || '（無）';
      const g = m.get(k) || { key: k, opened: 0, completed: 0, lead: 0 };
      g.opened++; if (r.stage >= 2) g.completed++; if (r.stage >= 4) g.lead++;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.opened - a.opened).slice(0, 20);
  };

  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * 864e5 + 8 * 3600e3).toISOString().slice(0, 10); // 台北日期
    daily.set(d, { day: d, opened: 0, completed: 0, lead: 0 });
  }
  for (const r of live) {
    const d = new Date(Date.parse(r.started_at) + 8 * 3600e3).toISOString().slice(0, 10);
    const g = daily.get(d); if (!g) continue;
    g.opened++; if (r.stage >= 2) g.completed++; if (r.stage >= 4) g.lead++;
  }

  const fb = await c.env.DB.prepare(
    `SELECT f.accuracy, COUNT(*) AS n FROM feedback f JOIN quiz_sessions s ON s.id = f.session_id
     WHERE s.started_at > ? GROUP BY f.accuracy`).bind(since).all();

  return c.json({
    days, funnel, questions,
    drops: { intro: dropIntro, gate: dropGate, result: dropResult },
    bySource: group(r => r.utm_source || r.entry || (r.ref ? 'ref:' + r.ref : 'direct')),
    byContext: group(r => r.is_in_client ? 'LINE 內：' + (r.context_type || '未知') : '外部瀏覽器'),
    byCourse: group(r => r.course).filter(g => g.key !== '（無）'),
    daily: [...daily.values()],
    feedback: fb.results
  });
});

app.get('/api/admin/sessions', async c => {
  const { since, trialSql } = rangeFilter(c);
  const stage = c.req.query('stage');
  const stageSql = stage === 'dropped' ? ' AND s.stage <= 1 AND s.resumed_by IS NULL' : stage === 'nolead' ? ' AND s.stage BETWEEN 2 AND 3' :
    stage === 'lead' ? ' AND s.stage = 4' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.login_uid, s.display_name, s.picture_url, s.email, s.stage, s.status, s.last_q, s.current_screen,
            s.course, s.plan, s.result_type, s.high_intent, s.gate_action, s.result_depth, s.q10_pref,
            s.utm_source, s.utm_campaign, s.entry, s.ref, s.context_type, s.is_in_client, s.os, s.visit_no, s.is_trial, s.resumed_by,
            s.started_at, s.last_seen_at, s.completed_at, s.lead_at,
            l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
     FROM quiz_sessions s LEFT JOIN leads l ON l.session_id = s.id
     WHERE s.started_at > ?${trialSql.replace('is_trial', 's.is_trial')}${stageSql}
     ORDER BY s.last_seen_at DESC LIMIT 300`).bind(since).all();
  return c.json({ sessions: results });
});

app.get('/api/admin/session/:id', async c => {
  const id = c.req.param('id');
  const s = await c.env.DB.prepare('SELECT * FROM quiz_sessions WHERE id = ?').bind(id).first();
  if (!s) return c.json({ error: 'not_found' }, 404);
  delete s.token_hash;
  const ev = await c.env.DB.prepare('SELECT type, q, payload_json, at FROM quiz_events WHERE session_id = ? ORDER BY at, id LIMIT 1500').bind(id).all();
  const leads = await c.env.DB.prepare('SELECT name, phone, email, consent_version, created_at FROM leads WHERE session_id = ?').bind(id).all();
  const fb = await c.env.DB.prepare('SELECT tester, accuracy, expected, comment, created_at FROM feedback WHERE session_id = ?').bind(id).all();
  const others = s.login_uid ? (await c.env.DB.prepare(
    'SELECT id, stage, last_q, course, started_at FROM quiz_sessions WHERE login_uid = ? AND id != ? ORDER BY started_at DESC LIMIT 20')
    .bind(s.login_uid, id).all()).results : [];
  return c.json({ session: s, events: ev.results, leads: leads.results, feedback: fb.results, otherVisits: others });
});

app.get('/api/admin/export.csv', async c => {
  const { since, trialSql } = rangeFilter(c);
  const { results } = await c.env.DB.prepare(
    `SELECT s.started_at, s.display_name, s.login_uid, s.status, s.last_q, s.course, s.plan, s.high_intent, s.gate_action, s.q10_pref,
            s.utm_source, s.utm_medium, s.utm_campaign, s.entry, s.ref, s.context_type, s.os, s.visit_no, s.is_trial,
            l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
     FROM quiz_sessions s LEFT JOIN leads l ON l.session_id = s.id
     WHERE s.started_at > ?${trialSql.replace('is_trial', 's.is_trial')} ORDER BY s.started_at DESC LIMIT 10000`).bind(since).all();
  const cols = results.length ? Object.keys(results[0]) : ['started_at'];
  const cell = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;               // 防止試算表公式注入
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + [cols.join(','), ...results.map(r => cols.map(k => cell(r[k])).join(','))].join('\n');
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="quiz-sessions.csv"' } });
});

app.all('/api/*', c => c.json({ error: 'not_found' }, 404));

export default app;
