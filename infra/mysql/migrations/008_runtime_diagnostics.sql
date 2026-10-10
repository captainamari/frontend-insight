CREATE TABLE IF NOT EXISTS diagnostic_policies (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  version VARCHAR(64) NOT NULL DEFAULT 'd0-1',
  retention_days INT NOT NULL DEFAULT 14,
  CONSTRAINT fk_diagnostic_policy_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT chk_diagnostic_retention CHECK(retention_days BETWEEN 1 AND 90)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS diagnostic_grants (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT FALSE,
  can_export BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(project_id,user_id),
  CONSTRAINT fk_diagnostic_grant_member FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE CASCADE,
  CONSTRAINT chk_diagnostic_export CHECK(can_export = FALSE OR can_read = TRUE)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS diagnostic_receipts (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id VARCHAR(72) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('pending','ready','write_failed','rate_limited','too_large','unavailable') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY(project_id,event_id),
  INDEX diagnostic_receipt_expiry(expires_at),
  CONSTRAINT fk_diagnostic_receipt_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS diagnostic_rate_windows (
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_view_id VARCHAR(72) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start BIGINT NOT NULL,
  admitted INT NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,page_view_id,window_start)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS diagnostic_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_id VARCHAR(128) NOT NULL,
  action VARCHAR(32) NOT NULL,
  result VARCHAR(32) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX diagnostic_audit_project(project_id,created_at)
) ENGINE=InnoDB;
