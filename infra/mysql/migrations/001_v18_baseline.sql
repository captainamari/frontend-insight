-- Frontend Insight v1.8 pre-1.0 empty-database baseline.
-- This is intentionally a rebuild, not an upgrade or compatibility migration.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  global_role VARCHAR(16) NOT NULL DEFAULT 'viewer',
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_users_global_role CHECK (global_role IN ('admin', 'viewer'))
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
  app_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_projects_app_id (app_id),
  KEY idx_projects_status (status, disabled_at),
  CONSTRAINT chk_projects_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_projects_retention CHECK (retention_days BETWEEN 1 AND 365),
  CONSTRAINT fk_projects_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS modules (
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
  UNIQUE KEY uq_modules_key (project_id, module_key),
  KEY idx_modules_order (project_id, status, display_order),
  CONSTRAINT chk_modules_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_modules_weight CHECK (criticality_weight > 0 AND criticality_weight <= 100),
  CONSTRAINT fk_modules_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS page_definitions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  module_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_route VARCHAR(512) NOT NULL,
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
  UNIQUE KEY uq_page_definitions_route (project_id, page_route),
  KEY idx_page_definitions_module (module_id, status, effective_from),
  CONSTRAINT chk_page_definitions_template CHECK (template_key IN ('monitoring_dashboard', 'analysis_view', 'task_operation')),
  CONSTRAINT chk_page_definitions_frequency CHECK (expected_frequency IN ('daily', 'weekly', 'monthly', 'ad_hoc')),
  CONSTRAINT chk_page_definitions_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_page_definitions_weight CHECK (criticality_weight > 0 AND criticality_weight <= 100),
  CONSTRAINT fk_page_definitions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_page_definitions_module FOREIGN KEY (module_id) REFERENCES modules (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS features (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  feature_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  feature_type VARCHAR(16) NOT NULL,
  page_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  is_key_task BOOLEAN NOT NULL DEFAULT FALSE,
  task_weight DECIMAL(8, 4) NOT NULL DEFAULT 1,
  task_timeout_seconds INT UNSIGNED NOT NULL DEFAULT 900,
  operation_lifecycle_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  configuration_effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  long_view_success_after_ms INT UNSIGNED NOT NULL DEFAULT 30000,
  heartbeat_interval_ms INT UNSIGNED NOT NULL DEFAULT 60000,
  launched_at TIMESTAMP(3) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_features_project_key (project_id, feature_key),
  KEY idx_features_page_task (page_definition_id, is_key_task, status),
  CONSTRAINT chk_features_type CHECK (feature_type IN ('data_view', 'action', 'long_view')),
  CONSTRAINT chk_features_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_features_task_weight CHECK (task_weight > 0 AND task_weight <= 100),
  CONSTRAINT fk_features_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_features_page_definition FOREIGN KEY (page_definition_id) REFERENCES page_definitions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  module_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  disabled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_workflow_definitions_key (project_id, workflow_key),
  KEY idx_workflow_definitions_module (module_id, status),
  CONSTRAINT chk_workflow_definitions_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT fk_workflow_definitions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_workflow_definitions_module FOREIGN KEY (module_id) REFERENCES modules (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflow_definition_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  workflow_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  start_policy VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_policy JSON NOT NULL,
  timeout_seconds INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  activated_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_workflow_versions (workflow_definition_id, version),
  CONSTRAINT chk_workflow_start_policy CHECK (start_policy IN ('explicit_sdk', 'first_step')),
  CONSTRAINT chk_workflow_version_status CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT chk_workflow_timeout CHECK (timeout_seconds BETWEEN 30 AND 604800),
  CONSTRAINT fk_workflow_versions_definition FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflow_steps (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  workflow_definition_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  step_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  step_order INT UNSIGNED NOT NULL,
  trigger_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trigger_config JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_workflow_steps_key (workflow_definition_version_id, step_key),
  UNIQUE KEY uq_workflow_steps_order (workflow_definition_version_id, step_order),
  CONSTRAINT chk_workflow_step_order CHECK (step_order BETWEEN 1 AND 20),
  CONSTRAINT chk_workflow_trigger_kind CHECK (trigger_kind IN ('explicit_sdk', 'selector', 'network_request', 'page_lifecycle', 'operation_terminal')),
  CONSTRAINT fk_workflow_steps_version FOREIGN KEY (workflow_definition_version_id) REFERENCES workflow_definition_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_library_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  version INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  manifest_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  activated_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_metric_library_version (version),
  CONSTRAINT chk_metric_library_status CHECK (status IN ('draft', 'active', 'retired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_definitions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  library_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metric_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  unit VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  implementation_status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  formula_ast JSON NULL,
  denominator_definition VARCHAR(1000) NULL,
  minimum_sample INT UNSIGNED NULL,
  UNIQUE KEY uq_metric_definitions_key (library_version_id, metric_key),
  CONSTRAINT chk_metric_implementation_status CHECK (implementation_status IN ('implemented', 'partial', 'not_collected')),
  CONSTRAINT fk_metric_definitions_library FOREIGN KEY (library_version_id) REFERENCES metric_library_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS metric_display_bindings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  metric_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  route_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  surface_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_metric_display_binding (metric_definition_id, route_name, surface_key),
  CONSTRAINT fk_metric_display_metric FOREIGN KEY (metric_definition_id) REFERENCES metric_definitions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS score_definitions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  library_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  score_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  version INT UNSIGNED NOT NULL,
  gate_ast JSON NOT NULL,
  color_bands JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  activated_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_score_definitions_version (score_key, version),
  CONSTRAINT chk_score_definition_status CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT fk_score_definitions_library FOREIGN KEY (library_version_id) REFERENCES metric_library_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS score_dimensions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  score_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dimension_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  weight DECIMAL(8, 6) NOT NULL,
  UNIQUE KEY uq_score_dimensions_key (score_definition_id, dimension_key),
  CONSTRAINT chk_score_dimension_weight CHECK (weight > 0 AND weight <= 1),
  CONSTRAINT fk_score_dimensions_definition FOREIGN KEY (score_definition_id) REFERENCES score_definitions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS score_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  score_dimension_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metric_definition_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  weight DECIMAL(8, 6) NOT NULL,
  target_config JSON NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_score_items_metric (score_dimension_id, metric_definition_id),
  CONSTRAINT chk_score_item_weight CHECK (weight > 0 AND weight <= 1),
  CONSTRAINT fk_score_items_dimension FOREIGN KEY (score_dimension_id) REFERENCES score_dimensions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_score_items_metric FOREIGN KEY (metric_definition_id) REFERENCES metric_definitions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS probe_policies (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  policy_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL,
  rules JSON NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  UNIQUE KEY uq_probe_policy_key (policy_key, effective_from),
  CONSTRAINT chk_probe_policy_status CHECK (status IN ('recommended', 'supported', 'deprecated', 'blocked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS export_interfaces (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  interface_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  scopes JSON NOT NULL,
  rate_limit_per_minute INT UNSIGNED NOT NULL DEFAULT 60,
  UNIQUE KEY uq_export_interfaces_key (project_id, interface_key),
  CONSTRAINT fk_export_interfaces_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS export_credentials (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  export_interface_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_prefix VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_export_credentials_hash (token_hash),
  CONSTRAINT fk_export_credentials_interface FOREIGN KEY (export_interface_id) REFERENCES export_interfaces (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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

-- Existing R0 computation code continues to read these versioned project profiles.
CREATE TABLE IF NOT EXISTS project_operational_settings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  target_users INT UNSIGNED NULL,
  expected_active_weekdays JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  effective_from TIMESTAMP(3) NOT NULL,
  effective_to TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_project_operational_settings_version (project_id, version),
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
  UNIQUE KEY uq_metric_profile_items_metric (profile_id, metric_key),
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
  UNIQUE KEY uq_metric_profile_assignments_effective (project_id, entity_type, entity_id, effective_from),
  CONSTRAINT fk_metric_profile_assignments_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_metric_profile_assignments_profile FOREIGN KEY (profile_id) REFERENCES metric_profiles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_metric_profile_assignments_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
