CREATE TABLE IF NOT EXISTS organization_directory_versions (
  id CHAR(36) PRIMARY KEY,
  project_id CHAR(36) NOT NULL,
  env ENUM('prod','staging','dev') NOT NULL,
  source_key VARCHAR(64) NOT NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'draft',
  coverage ENUM('complete','unknown') NOT NULL,
  entries_json JSON NOT NULL,
  entry_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  valid_until DATETIME(3) NOT NULL,
  UNIQUE KEY directory_publication (project_id, env, published_at),
  INDEX directory_scope (project_id, env, published_at),
  CONSTRAINT directory_project FOREIGN KEY (project_id) REFERENCES projects(id)
);
