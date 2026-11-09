-- Indexes for the site-wide caps on new questions and messages (enforceRateLimits),
-- so counting the last hour or day reads only those rows.
CREATE INDEX idx_threads_created  ON threads (created_at);
CREATE INDEX idx_messages_created ON messages (created_at);
