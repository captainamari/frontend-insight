CREATE TABLE IF NOT EXISTS project_modules (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  module_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  criticality_weight DECIMAL(8, 4) NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_project_modules_key (project_id, module_key),
  KEY idx_project_modules_order (project_id, status, display_order),
  CONSTRAINT chk_project_modules_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_project_modules_weight CHECK (criticality_weight > 0 AND criticality_weight <= 100),
  CONSTRAINT fk_project_modules_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS page_definitions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  module_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  normalized_route VARCHAR(512) NOT NULL,
  name VARCHAR(120) NOT NULL,
  template_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_core BOOLEAN NOT NULL DEFAULT FALSE,
  criticality_weight DECIMAL(8, 4) NOT NULL DEFAULT 1,
  expected_frequency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'weekly',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_page_definitions_route (project_id, normalized_route),
  KEY idx_page_definitions_module (module_id, status, effective_from),
  CONSTRAINT chk_page_definitions_template CHECK (template_key IN ('monitoring_dashboard', 'analysis_view', 'task_operation')),
  CONSTRAINT chk_page_definitions_frequency CHECK (expected_frequency IN ('daily', 'weekly', 'monthly', 'ad_hoc')),
  CONSTRAINT chk_page_definitions_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_page_definitions_weight CHECK (criticality_weight > 0 AND criticality_weight <= 100),
  CONSTRAINT fk_page_definitions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_page_definitions_module FOREIGN KEY (module_id) REFERENCES project_modules (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE features
  ADD COLUMN page_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER feature_type,
  ADD COLUMN is_key_task BOOLEAN NOT NULL DEFAULT FALSE AFTER page_definition_id,
  ADD COLUMN task_weight DECIMAL(8, 4) NOT NULL DEFAULT 1 AFTER is_key_task,
  ADD COLUMN task_timeout_seconds INT UNSIGNED NOT NULL DEFAULT 900 AFTER task_weight,
  ADD COLUMN operation_lifecycle_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER task_timeout_seconds,
  ADD COLUMN configuration_effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER operation_lifecycle_enabled,
  ADD KEY idx_features_page_task (page_definition_id, is_key_task, status),
  ADD CONSTRAINT chk_features_task_weight CHECK (task_weight > 0 AND task_weight <= 100),
  ADD CONSTRAINT chk_features_task_timeout CHECK (task_timeout_seconds BETWEEN 30 AND 86400),
  ADD CONSTRAINT fk_features_page_definition FOREIGN KEY (page_definition_id) REFERENCES page_definitions (id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS project_operational_settings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  target_accounts INT UNSIGNED NULL,
  expected_active_weekdays JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  effective_from TIMESTAMP(3) NOT NULL,
  effective_to TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_project_operational_settings_version (project_id, version),
  KEY idx_project_operational_settings_effective (project_id, status, effective_from, effective_to),
  CONSTRAINT chk_project_operational_settings_status CHECK (status IN ('active', 'superseded')),
  CONSTRAINT chk_project_operational_target_accounts CHECK (target_accounts IS NULL OR target_accounts > 0),
  CONSTRAINT fk_project_operational_settings_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_project_operational_settings_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_profiles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  version INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  effective_from TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_metric_profiles_version (project_id, profile_key, version),
  KEY idx_metric_profiles_status (project_id, status, effective_from),
  CONSTRAINT chk_metric_profiles_status CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT fk_metric_profiles_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_metric_profiles_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_profile_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metric_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dimension_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dimension_weight DECIMAL(8, 6) NOT NULL,
  metric_weight DECIMAL(8, 6) NOT NULL,
  target_value DECIMAL(20, 6) NULL,
  floor_value DECIMAL(20, 6) NULL,
  ceiling_value DECIMAL(20, 6) NULL,
  target_min DECIMAL(20, 6) NULL,
  target_max DECIMAL(20, 6) NULL,
  tolerance_min DECIMAL(20, 6) NULL,
  tolerance_max DECIMAL(20, 6) NULL,
  minimum_sample INT UNSIGNED NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_metric_profile_items_metric (profile_id, metric_key),
  KEY idx_metric_profile_items_dimension (profile_id, dimension_key),
  CONSTRAINT chk_metric_profile_dimension_weight CHECK (dimension_weight > 0 AND dimension_weight <= 1),
  CONSTRAINT chk_metric_profile_metric_weight CHECK (metric_weight > 0 AND metric_weight <= 1),
  CONSTRAINT fk_metric_profile_items_profile FOREIGN KEY (profile_id) REFERENCES metric_profiles (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_profile_assignments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  effective_to TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_metric_profile_assignments_effective (project_id, entity_type, entity_id, effective_from, effective_to),
  CONSTRAINT chk_metric_profile_assignments_entity CHECK (entity_type IN ('project', 'module', 'page', 'task')),
  CONSTRAINT fk_metric_profile_assignments_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_metric_profile_assignments_profile FOREIGN KEY (profile_id) REFERENCES metric_profiles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_metric_profile_assignments_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
