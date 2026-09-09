-- Additive migration: preserve the accepted baseline and existing project data.
ALTER TABLE score_definitions
 ADD COLUMN configuration JSON NULL,
 ADD COLUMN dependency_snapshot JSON NULL,
 ADD COLUMN reviewed_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 DROP INDEX uq_score_definitions_version,
 ADD UNIQUE KEY uq_score_library_version (library_version_id);
ALTER TABLE score_items ADD INDEX ix_score_item_dimension (score_dimension_id);
ALTER TABLE score_items DROP INDEX uq_score_items_metric;
CREATE TABLE metric_activation_periods (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 library_type VARCHAR(16) NOT NULL,
 library_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 effective_from TIMESTAMP(3) NOT NULL,
 effective_to TIMESTAMP(3) NULL,
 INDEX ix_metric_period_scope (project_id,library_type,effective_from),
 FOREIGN KEY (library_version_id) REFERENCES metric_library_versions(id)
);
CREATE TABLE score_historical_trials (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 library_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 definition_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 requested_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 query_context JSON NOT NULL,
 result_snapshot JSON NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX ix_score_trials_version (project_id,library_version_id,created_at),
 FOREIGN KEY (library_version_id) REFERENCES metric_library_versions(id)
);
