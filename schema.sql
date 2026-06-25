-- ========== POSTS (índice) ==========
CREATE TABLE IF NOT EXISTS posts (
    slug               TEXT PRIMARY KEY,
    current_release_id TEXT NOT NULL,
    current_version    INTEGER DEFAULT 1,
    title              TEXT NOT NULL,
    author             TEXT DEFAULT 'Author',
    excerpt_cache      TEXT,
    image_url_cache    TEXT,
    status             TEXT DEFAULT 'published',
    default_hashtags   TEXT DEFAULT '',
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== VERSIONES ==========
CREATE TABLE IF NOT EXISTS post_versions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                TEXT NOT NULL,
    version             INTEGER NOT NULL,
    release_id          TEXT NOT NULL,
    release_tag         TEXT NOT NULL,
    release_url         TEXT NOT NULL,
    article_url         TEXT NOT NULL,
    image_url           TEXT,
    meta_url            TEXT NOT NULL,
    atproto_uri         TEXT,
    excerpt             TEXT,
    word_count          INTEGER DEFAULT 0,
    reading_time        INTEGER DEFAULT 1,
    change_description  TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (slug) REFERENCES posts(slug) ON DELETE CASCADE
);

-- ========== SOFT DELETE ==========
CREATE TABLE IF NOT EXISTS post_deletions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL,
    deleted_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason          TEXT,
    last_release_id TEXT,
    FOREIGN KEY (slug) REFERENCES posts(slug) ON DELETE CASCADE
);

-- ========== TOKENS DE REDES SOCIALES (CIFRADOS) ==========
CREATE TABLE IF NOT EXISTS social_tokens (
    platform          TEXT PRIMARY KEY,
    handle            TEXT,
    encrypted_payload TEXT NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== REGISTRO DE PUBLICACIONES ==========
CREATE TABLE IF NOT EXISTS social_shares (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    post_slug         TEXT NOT NULL,
    platform          TEXT NOT NULL,
    platform_post_id  TEXT,
    platform_post_url TEXT,
    status            TEXT DEFAULT 'published',
    error_msg         TEXT,
    shared_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_slug) REFERENCES posts(slug) ON DELETE CASCADE
);

-- ========== PROGRAMACIONES ==========
CREATE TABLE IF NOT EXISTS publication_schedules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    post_slug           TEXT NOT NULL,
    name                TEXT,
    schedule_type       TEXT DEFAULT 'once',
    platforms           TEXT DEFAULT '[]',
    message_template    TEXT,
    custom_hashtags     TEXT DEFAULT '',
    scheduled_at        DATETIME,
    recurrence_interval INTEGER,
    recurrence_unit     TEXT,
    max_occurrences     INTEGER,
    occurrence_count    INTEGER DEFAULT 0,
    next_occurrence     DATETIME,
    status              TEXT DEFAULT 'active',
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_slug) REFERENCES posts(slug) ON DELETE CASCADE
);

-- ========== HISTORIAL ==========
CREATE TABLE IF NOT EXISTS publication_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    post_slug         TEXT NOT NULL,
    schedule_id       INTEGER,
    platform          TEXT NOT NULL,
    platform_post_id  TEXT,
    message_used      TEXT,
    published_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    status            TEXT DEFAULT 'success',
    is_republish      INTEGER DEFAULT 0,
    FOREIGN KEY (post_slug) REFERENCES posts(slug) ON DELETE CASCADE
);

-- ========== HASHTAGS ==========
CREATE TABLE IF NOT EXISTS hashtag_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    template    TEXT NOT NULL,
    day_of_week INTEGER,
    is_default  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== SETTINGS ==========
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== ÍNDICES ==========
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_slug ON post_versions(slug, version DESC);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON publication_schedules(next_occurrence);
CREATE INDEX IF NOT EXISTS idx_schedules_status ON publication_schedules(status);
CREATE INDEX IF NOT EXISTS idx_social_slug ON social_shares(post_slug);
CREATE INDEX IF NOT EXISTS idx_history_slug ON publication_history(post_slug);

-- ========== DATOS INICIALES ==========
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('blog_name', 'My Blog'),
    ('blog_description', 'An autonomous personal blog'),
    ('author_name', 'Author'),
    ('language', 'en');

INSERT OR IGNORE INTO hashtag_templates (name, template, day_of_week, is_default) VALUES
    ('Sunday', '#Sunday #Reading', 0, 1),
    ('Monday', '#Monday #NewWeek #Motivation', 1, 1),
    ('Tuesday', '#Tuesday #Coffee', 2, 1),
    ('Wednesday', '#Wednesday #KeepGoing', 3, 1),
    ('Thursday', '#Thursday #AlmostThere', 4, 1),
    ('Friday', '#Friday #Weekend', 5, 1),
    ('Saturday', '#Saturday #Relax #Reading', 6, 1);
