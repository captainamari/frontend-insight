-- D5 additive private artifact catalog. Identity keys are hashes of canonical tuples.
CREATE TABLE diagnostic_upload_credentials (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 expires_at DATETIME(3) NOT NULL,
 revoked BOOLEAN NOT NULL DEFAULT FALSE,
 INDEX sourcemap_credentials_project(project_id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE diagnostic_sourcemaps (
 id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 release_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 build_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 asset VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 asset_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 map_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 byte_size INT NOT NULL,
 state ENUM('ready','deleted','expired') NOT NULL DEFAULT 'ready',
 expires_at DATETIME(3) NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX sourcemap_project_version(project_id,release_id,build_id),
 INDEX sourcemap_expiry(state,expires_at),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;
