-- 結構認證路徑測驗：作答紀錄、行為事件、留資料、試填回饋

-- 一次作答一筆。一打開 LIFF 就建立，之後持續更新（目前狀態的快照）
CREATE TABLE quiz_sessions (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,              -- 這次作答的寫入憑證（只存雜湊）

  -- 身分（全部來自後端驗證過的 LINE ID Token；不在 LIFF 內打開時為空）
  login_uid       TEXT,
  display_name    TEXT,
  picture_url     TEXT,
  email           TEXT,
  anon_id         TEXT,                       -- 同一台裝置的匿名代號（LIFF 外開啟時用來串回訪）
  id_verified     INTEGER NOT NULL DEFAULT 0,

  -- 進度
  stage           INTEGER NOT NULL DEFAULT 0, -- 0 已打開 1 作答中 2 完成 3 看到留資料頁 4 已留資料
  status          TEXT NOT NULL DEFAULT 'opened',
  last_q          INTEGER NOT NULL DEFAULT 0, -- 已答到第幾題（0 = 還沒答）
  current_screen  TEXT,                       -- 最後停在哪個畫面（intro / q3 / gate / result）
  answers_json    TEXT,
  q_times_json    TEXT,                       -- 每題花的毫秒數
  backs           INTEGER NOT NULL DEFAULT 0,
  changes         INTEGER NOT NULL DEFAULT 0,

  -- 結果
  result_type     TEXT,
  course          TEXT,
  plan            TEXT,
  high_intent     INTEGER NOT NULL DEFAULT 0,
  q10_pref        TEXT,
  result_json     TEXT,
  gate_action     TEXT,                       -- submit / skip / line
  result_depth    TEXT,                       -- 結果頁捲到哪一段
  cta_clicks      INTEGER NOT NULL DEFAULT 0,

  -- 來源
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  utm_term        TEXT,
  ref             TEXT,                       -- 教練推薦碼
  entry           TEXT,                       -- richmenu / post / ad / share …
  click_ids_json  TEXT,                       -- fbclid / gclid
  landing_url     TEXT,
  referrer        TEXT,

  -- 環境
  context_type    TEXT,                       -- utou / group / room / external / none …
  view_type       TEXT,
  is_in_client    INTEGER,
  os              TEXT,
  language        TEXT,
  line_version    TEXT,
  user_agent      TEXT,
  timezone        TEXT,
  screen          TEXT,

  visit_no        INTEGER NOT NULL DEFAULT 1, -- 這個人第幾次打開
  resumed_from    TEXT,                       -- 接續哪一筆未完成的作答
  resumed_by      TEXT,                       -- 被哪一筆接續（跳出分析時排除）
  is_trial        INTEGER NOT NULL DEFAULT 0, -- 教練試填

  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  first_answer_at TEXT,
  completed_at    TEXT,
  lead_at         TEXT
);
CREATE INDEX idx_sessions_uid     ON quiz_sessions(login_uid);
CREATE INDEX idx_sessions_anon    ON quiz_sessions(anon_id);
CREATE INDEX idx_sessions_started ON quiz_sessions(started_at);
CREATE INDEX idx_sessions_stage   ON quiz_sessions(stage);

-- 每個動作一筆，只增不改（還原完整過程）
CREATE TABLE quiz_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  q           TEXT,
  payload_json TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX idx_events_session ON quiz_events(session_id, id);
CREATE INDEX idx_events_type    ON quiz_events(type, at);

-- 留資料（只有按下送出才會存）
CREATE TABLE leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  login_uid       TEXT,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_leads_session ON leads(session_id);
CREATE INDEX idx_leads_uid     ON leads(login_uid);

-- 教練試填回饋
CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tester      TEXT,
  accuracy    TEXT NOT NULL,
  expected    TEXT,
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_feedback_session ON feedback(session_id);
