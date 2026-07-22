ALTER TABLE users
  ADD COLUMN global_role VARCHAR(16) NOT NULL DEFAULT 'viewer' AFTER status,
  ADD CONSTRAINT chk_users_global_role CHECK (global_role IN ('admin', 'viewer'));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  refresh_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  revoked_at TIMESTAMP(3) NULL,
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_auth_sessions_refresh_hash (refresh_token_hash),
  KEY idx_auth_sessions_user_expiry (user_id, expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS project_data_status (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  last_received_at TIMESTAMP(3) NULL,
  last_ingested_at TIMESTAMP(3) NULL,
  last_queryable_at TIMESTAMP(3) NULL,
  last_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_sdk_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_rejection_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  accepted_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rejected_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
  dead_letter_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_project_data_status_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
