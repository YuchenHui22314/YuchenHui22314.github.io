-- A thread is one question plus the anonymous conversation that follows it.
CREATE TABLE threads (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,             -- unix ms
  updated_at       INTEGER NOT NULL,             -- last message of any kind
  published_at     INTEGER,                      -- time of the latest owner reply
  published_upto   INTEGER,                      -- id of the latest owner reply; public view shows messages up to it
  awaiting_reply   INTEGER NOT NULL DEFAULT 1,   -- 1 when the latest message is from the asker
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'hidden')),
  closed           INTEGER NOT NULL DEFAULT 0,   -- 1 = asker can no longer follow up
  asker_token_hash TEXT NOT NULL,
  ip_hash          TEXT,
  lang             TEXT
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author     TEXT NOT NULL CHECK (author IN ('asker', 'owner')),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  ip_hash    TEXT
);

CREATE INDEX idx_messages_thread ON messages (thread_id, id);
CREATE INDEX idx_messages_ip     ON messages (ip_hash, created_at);
CREATE INDEX idx_threads_public  ON threads (status, published_upto);
CREATE INDEX idx_threads_ip      ON threads (ip_hash, created_at);
CREATE INDEX idx_threads_updated ON threads (updated_at);
