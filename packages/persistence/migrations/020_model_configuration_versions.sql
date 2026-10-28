-- 模型配置版本独立于角色职责/权限版本；不猜填或提升旧启动握手。
ALTER TABLE roles ADD COLUMN model_preference_revision INTEGER NOT NULL DEFAULT 0 CHECK(model_preference_revision>=0);
CREATE TABLE role_model_revisions (
  project_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  role_revision INTEGER NOT NULL CHECK(role_revision>=1),
  requested_json TEXT,
  resolved_json TEXT,
  previous_effective_json TEXT,
  command_id TEXT REFERENCES commands(id),
  source_principal_id TEXT,
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
  origin TEXT NOT NULL CHECK(origin IN ('legacy_snapshot','trusted_internal','user_command')),
  PRIMARY KEY(project_id,role_id,revision),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE UNIQUE INDEX role_model_command_once ON role_model_revisions(command_id) WHERE command_id IS NOT NULL;
CREATE TRIGGER role_model_history_no_update BEFORE UPDATE ON role_model_revisions BEGIN SELECT RAISE(ABORT,'MODEL_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER role_model_history_no_delete BEFORE DELETE ON role_model_revisions BEGIN SELECT RAISE(ABORT,'MODEL_HISTORY_IMMUTABLE'); END;
UPDATE roles SET model_preference_revision=1 WHERE model_requested_json IS NOT NULL OR model_resolved_json IS NOT NULL;
INSERT INTO role_model_revisions(project_id,role_id,revision,role_revision,requested_json,resolved_json,previous_effective_json,command_id,source_principal_id,recorded_at,origin)
 SELECT project_id,id,1,revision,model_requested_json,model_resolved_json,model_effective_json,NULL,NULL,
 COALESCE(CAST(json_extract(model_requested_json,'$.recordedAt') AS INTEGER),0),'legacy_snapshot'
 FROM roles WHERE model_preference_revision=1;
