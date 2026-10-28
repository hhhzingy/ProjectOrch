-- 原生消息名称不构成身份；保留受信来源和原始关联，权限由领域服务核验。
CREATE TABLE source_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  native_event_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('authenticated_user','role_forwarded','native_unverified','kernel')),
  principal_id TEXT,
  command_id TEXT,
  binding_epoch INTEGER CHECK(binding_epoch IS NULL OR binding_epoch>=1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  observed_at INTEGER NOT NULL,
  UNIQUE(session_id,native_event_id),
  CHECK(source_kind<>'authenticated_user' OR principal_id IS NOT NULL),
  CHECK(source_kind<>'role_forwarded' OR command_id IS NOT NULL),
  FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id)
);
CREATE INDEX source_by_project ON source_observations(project_id,observed_at,id);
CREATE TRIGGER source_observations_immutable_update BEFORE UPDATE ON source_observations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_OBSERVATION'); END;
CREATE TRIGGER source_observations_immutable_delete BEFORE DELETE ON source_observations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_OBSERVATION'); END;
ALTER TABLE events ADD COLUMN source_observation_id TEXT REFERENCES source_observations(id);
ALTER TABLE events ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'kernel'
  CHECK(source_kind IN ('authenticated_user','role_forwarded','native_unverified','kernel'));
CREATE TRIGGER event_source_same_project BEFORE INSERT ON events
WHEN NEW.source_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM source_observations s WHERE s.id=NEW.source_observation_id AND s.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'CROSS_PROJECT_SOURCE'); END;
CREATE TRIGGER event_source_update_same_project BEFORE UPDATE OF project_id,source_observation_id ON events
WHEN NEW.source_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM source_observations s WHERE s.id=NEW.source_observation_id AND s.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'CROSS_PROJECT_SOURCE'); END;
