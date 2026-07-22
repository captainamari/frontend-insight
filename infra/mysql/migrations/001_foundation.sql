CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_status CHECK (status IN ('active', 'disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS identities (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(32) NOT NULL,
  subject VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NULL,
  last_authenticated_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_identities_provider_subject (provider, subject),
  KEY idx_identities_user (user_id),
  CONSTRAINT fk_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS projects (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_projects_project_key (project_key),
  KEY idx_projects_status (status, disabled_at),
  CONSTRAINT chk_projects_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_projects_retention CHECK (retention_days BETWEEN 1 AND 365),
  CONSTRAINT fk_projects_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
