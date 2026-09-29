-- Preserve existing objects, versions and facts. Historical enable/disable
-- periods cannot be reconstructed from current status: capture from now.
CREATE TABLE IF NOT EXISTS workflow_admission_periods (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  workflow_definition_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  effective_to TIMESTAMP(3) NULL,
  KEY idx_workflow_admission_version (workflow_definition_version_id, effective_from, effective_to),
  CONSTRAINT fk_workflow_admission_version FOREIGN KEY (workflow_definition_version_id) REFERENCES workflow_definition_versions(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workflow_admission_window CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO workflow_admission_periods (id, workflow_definition_version_id, effective_from)
SELECT UUID(), v.id, CURRENT_TIMESTAMP(3)
FROM workflow_definition_versions v JOIN workflow_definitions w ON w.id=v.workflow_definition_id
WHERE v.status='active' AND w.status='active' AND w.archived_at IS NULL
AND NOT EXISTS (SELECT 1 FROM workflow_admission_periods p WHERE p.workflow_definition_version_id=v.id);
ALTER TABLE workflow_definition_versions DROP CHECK chk_workflow_timeout,
 ADD CONSTRAINT chk_workflow_timeout CHECK (timeout_seconds BETWEEN 1 AND 604800);
