-- Atomic project + two unconfirmed template drafts; retry identity is user scoped.
CREATE TABLE IF NOT EXISTS project_creation_requests (
  actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_digest CHAR(64) NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_user_id, request_id),
  CONSTRAINT fk_creation_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_creation_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB;
