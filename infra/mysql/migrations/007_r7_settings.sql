ALTER TABLE probe_policies
  ADD COLUMN project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  DROP INDEX uq_probe_policy_key,
  ADD UNIQUE KEY uq_project_probe (project_id, policy_key),
  ADD CONSTRAINT fk_probe_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE export_interfaces
  ADD COLUMN last_called_at TIMESTAMP(3) NULL,
  ADD COLUMN last_status VARCHAR(32) NULL;
CREATE TABLE IF NOT EXISTS export_rate_windows (
  export_interface_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  window_start BIGINT NOT NULL,
  calls INT UNSIGNED NOT NULL,
  CONSTRAINT fk_export_rate_interface FOREIGN KEY (export_interface_id) REFERENCES export_interfaces(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS abnormal_rule_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_key VARCHAR(32) NOT NULL,
  config JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  approval JSON NULL,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_abnormal_project (project_id, created_at),
  CONSTRAINT fk_abnormal_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT chk_abnormal_status CHECK (status IN ('draft','approved','enabled','disabled'))
) ENGINE=InnoDB;
