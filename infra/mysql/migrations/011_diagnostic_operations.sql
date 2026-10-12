-- Additive D6 policy publication, deletion tombstones and bounded health receipts.
ALTER TABLE diagnostic_policies ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN config JSON NULL,
 ADD COLUMN updated_at DATETIME(3) NULL;
ALTER TABLE diagnostic_receipts
 MODIFY COLUMN state ENUM('pending','ready','write_failed','rate_limited','too_large','unavailable','disabled','policy_suppressed','deleted') NOT NULL,
 ADD COLUMN byte_size INT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN persisted_at DATETIME(3) NULL,
 ADD COLUMN deleted_at DATETIME(3) NULL,
 ADD INDEX diagnostic_receipt_created(project_id,created_at,event_id);
CREATE TABLE diagnostic_deletions (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 event_id VARCHAR(72) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL,
 cleaned_at DATETIME(3) NULL,
 UNIQUE KEY diagnostic_deleted_event(project_id,event_id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE diagnostic_health (
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 client_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 sequence_no INT UNSIGNED NOT NULL,
 observed_at DATETIME(3) NOT NULL,
 metadata JSON NOT NULL,
 PRIMARY KEY(project_id,client_id),
 INDEX diagnostic_health_observed(observed_at),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE diagnostic_maintenance (
 component VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 success_at DATETIME(3) NULL,
 failure_at DATETIME(3) NULL,
 error_code VARCHAR(64) NULL
) ENGINE=InnoDB;
