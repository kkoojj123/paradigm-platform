-- 游戏IF剧场约稿平台 D1 数据库建表
-- 在 Cloudflare D1 中执行: wrangler d1 execute paradigm-platform --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL DEFAULT 'creator',
    username TEXT UNIQUE NOT NULL,
    password TEXT,
    display_name TEXT DEFAULT '',
    xhs_uid TEXT DEFAULT '',
    xhs_avatar TEXT DEFAULT '',
    company TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    xhs_profile_url TEXT DEFAULT '',
    xhs_screenshot TEXT DEFAULT '',
    verify_status TEXT DEFAULT 'pending',
    verify_note TEXT DEFAULT '',
    verified_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'topic',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    benefits TEXT DEFAULT '',
    reward_amount INTEGER DEFAULT 0,
    reward_rules TEXT DEFAULT '',
    ref_notes TEXT DEFAULT '[]',
    requirements TEXT DEFAULT '',
    directions TEXT DEFAULT '[]',
    source TEXT DEFAULT 'operator',
    status TEXT DEFAULT 'published',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    cover_url TEXT DEFAULT '',
    deadline TEXT DEFAULT '',
    participant_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    note_id TEXT DEFAULT '',
    note_title TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    likes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    reviewed_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    submit_type TEXT DEFAULT 'existing',
    note_link TEXT DEFAULT '',
    profile_link TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    real_name TEXT DEFAULT '',
    draft_content TEXT DEFAULT '',
    review_status TEXT DEFAULT 'pending',
    review_note TEXT DEFAULT '',
    creator_name TEXT DEFAULT '',
    submission_number INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hot_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT UNIQUE NOT NULL,
    title TEXT DEFAULT '',
    cover TEXT DEFAULT '',
    likes INTEGER DEFAULT 0,
    author TEXT DEFAULT '',
    game_ip TEXT DEFAULT '',
    fetched_at TEXT DEFAULT (datetime('now')),
    pattern_type TEXT DEFAULT '',
    sample_notes TEXT DEFAULT '[]',
    why_hot TEXT DEFAULT '',
    how_to TEXT DEFAULT ''
);

-- 预置运营账号 (密码 xhs2026 的 sha256)
INSERT OR IGNORE INTO users (role, username, password, display_name, verify_status)
VALUES ('operator', 'operator', 'c623215db1866e00681a682182f4ae93dec25e5c6e7b7018113e15e835a5dd41', '运营君', 'approved');
