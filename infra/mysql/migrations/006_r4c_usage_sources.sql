CREATE TABLE IF NOT EXISTS usage_source_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  env ENUM('prod','staging','dev') NOT NULL,
  source_key VARCHAR(64) NOT NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'draft',
  coverage ENUM('complete','interrupted') NOT NULL,
  sdk_version VARCHAR(32) NOT NULL,
  releases_json JSON NOT NULL,
  scope_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  valid_until DATETIME(3) NOT NULL,
  UNIQUE KEY usage_publication (project_id, env, published_at),
  CONSTRAINT usage_source_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
