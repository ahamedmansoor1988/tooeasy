CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  source_app TEXT,
  source_app_name TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  deleted_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_captured_at ON screenshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_source_app ON screenshots(source_app);
CREATE INDEX IF NOT EXISTS idx_deleted_at ON screenshots(deleted_at);
