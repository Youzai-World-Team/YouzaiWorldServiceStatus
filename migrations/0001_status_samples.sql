CREATE TABLE IF NOT EXISTS status_samples (
  captured_at INTEGER PRIMARY KEY,
  overall TEXT NOT NULL,
  services_json TEXT NOT NULL,
  node_json TEXT NOT NULL,
  minecraft_json TEXT NOT NULL,
  errors_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS status_samples_captured_idx
  ON status_samples (captured_at DESC);
