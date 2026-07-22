CREATE TABLE IF NOT EXISTS features (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  feature_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  feature_type VARCHAR(16) NOT NULL,
  success_threshold_ms BIGINT UNSIGNED NULL,
  long_view_success_after_ms INT UNSIGNED NOT NULL DEFAULT 30000,
  heartbeat_interval_ms INT UNSIGNED NOT NULL DEFAULT 60000,
  launched_at TIMESTAMP(3) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_features_project_key (project_id, feature_key),
  KEY idx_features_project_status (project_id, status, launched_at),
  CONSTRAINT chk_features_type CHECK (feature_type IN ('data_view', 'action', 'long_view')),
  CONSTRAINT chk_features_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT fk_features_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS project_origins (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_project_origins_origin (project_id, origin),
  CONSTRAINT fk_project_origins_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS project_members (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id, user_id),
  KEY idx_project_members_user (user_id, project_id),
  CONSTRAINT chk_project_members_role CHECK (role IN ('owner', 'admin', 'viewer')),
  CONSTRAINT fk_project_members_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_project_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata JSON NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_logs_project_time (project_id, created_at),
  KEY idx_audit_logs_actor_time (actor_user_id, created_at),
  KEY idx_audit_logs_request (request_id),
  CONSTRAINT fk_audit_logs_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
