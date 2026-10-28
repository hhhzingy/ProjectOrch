-- 非任务原生输入有独立来源和预约；不伪造task，也不回填历史owned证明。
CREATE UNIQUE INDEX durable_operation_project_identity ON durable_operations(id,project_id);
CREATE TABLE native_write_effects (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 role_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('factory','message')),
 purpose TEXT NOT NULL CHECK(purpose IN ('factory','message','binding-tools')),
 source_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 operation_id TEXT,
 message_id TEXT,
 binding_id TEXT,
 binding_epoch INTEGER,
 session_json TEXT CHECK(session_json IS NULL OR json_valid(session_json)),
 target_root TEXT NOT NULL,
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 materialized_identity_json TEXT CHECK(materialized_identity_json IS NULL OR json_valid(materialized_identity_json)),
 proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64),
 owner_key TEXT NOT NULL,
 fence INTEGER NOT NULL CHECK(fence>=1),
 state TEXT NOT NULL CHECK(state IN ('reserved','active','unknown','settled')),
 phase TEXT NOT NULL CHECK(phase IN ('planned','created','charter','message','binding-tools','terminal','not_sent')),
 evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((source_kind='message' AND purpose='message') OR (source_kind='factory' AND purpose IN ('factory','binding-tools'))),
 CHECK((source_kind='factory' AND operation_id IS NOT NULL AND operation_id=source_id AND message_id IS NULL) OR (source_kind='message' AND message_id IS NOT NULL AND message_id=source_id AND operation_id IS NULL)),
 CHECK((binding_id IS NULL AND binding_epoch IS NULL) OR (binding_id IS NOT NULL AND binding_epoch IS NOT NULL AND binding_epoch>=1)),
 CHECK(source_kind='factory' OR (binding_id IS NOT NULL AND session_json IS NOT NULL)),
 CHECK(purpose<>'binding-tools' OR (binding_id IS NOT NULL AND session_json IS NOT NULL)),
 FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id),
 FOREIGN KEY(operation_id,project_id) REFERENCES durable_operations(id,project_id),
 FOREIGN KEY(message_id,project_id) REFERENCES messages(id,project_id),
 FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE INDEX native_write_effect_unresolved ON native_write_effects(state,project_id);
CREATE UNIQUE INDEX native_write_effect_one_active_source ON native_write_effects(source_kind,source_id,role_id) WHERE state IN ('reserved','active','unknown');
CREATE TRIGGER native_write_effect_source_link BEFORE INSERT ON native_write_effects
 WHEN (NEW.source_kind='message' AND NOT EXISTS(SELECT 1 FROM messages m JOIN commands c ON c.id=m.command_id AND c.project_id=m.project_id WHERE m.id=NEW.source_id AND m.project_id=NEW.project_id AND m.to_role_id=NEW.role_id AND m.state IN ('queued','sending')))
 OR (NEW.source_kind='factory' AND NOT EXISTS(SELECT 1 FROM durable_operations o WHERE o.id=NEW.source_id AND o.project_id=NEW.project_id AND o.kind IN ('project.bootstrap','role.provision','message.send') AND (NEW.purpose='binding-tools' OR o.state IN ('pending','running') OR (o.kind='project.bootstrap' AND o.state IN ('failed','unknown'))) AND (json_extract(o.payload_json,'$.roleId')=NEW.role_id OR json_extract(o.payload_json,'$.toRoleId')=NEW.role_id OR EXISTS(SELECT 1 FROM json_each(o.payload_json,'$.roles') r WHERE json_extract(r.value,'$.roleId')=NEW.role_id))))
 OR (NEW.binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM role_bindings b WHERE b.id=NEW.binding_id AND b.project_id=NEW.project_id AND b.role_id=NEW.role_id AND b.epoch=NEW.binding_epoch AND b.ended_at IS NULL))
 BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_SOURCE_LINK_REQUIRED'); END;
CREATE TRIGGER native_write_effect_identity_immutable BEFORE UPDATE ON native_write_effects
 WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.role_id<>OLD.role_id OR NEW.source_kind<>OLD.source_kind OR NEW.purpose<>OLD.purpose OR NEW.source_id<>OLD.source_id OR NEW.source_sha256<>OLD.source_sha256
 OR NEW.operation_id IS NOT OLD.operation_id OR NEW.message_id IS NOT OLD.message_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_epoch IS NOT OLD.binding_epoch
 OR NEW.session_json IS NOT OLD.session_json OR NEW.target_root<>OLD.target_root OR NEW.scope_json<>OLD.scope_json OR NEW.identity_json<>OLD.identity_json
 OR NEW.proof_sha256<>OLD.proof_sha256 OR NEW.owner_key<>OLD.owner_key OR NEW.fence<>OLD.fence OR NEW.created_at<>OLD.created_at
 OR (OLD.materialized_identity_json IS NOT NULL AND NEW.materialized_identity_json IS NOT OLD.materialized_identity_json)
 BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_EFFECT_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER native_write_effect_no_delete BEFORE DELETE ON native_write_effects BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_EFFECT_HISTORY_REQUIRED'); END;
CREATE TRIGGER native_write_effect_transition BEFORE UPDATE ON native_write_effects
 WHEN (OLD.state='settled' AND (NEW.state<>OLD.state OR NEW.phase<>OLD.phase OR NEW.evidence_json IS NOT OLD.evidence_json))
 OR (OLD.state='unknown' AND NEW.state NOT IN ('unknown','settled'))
 OR (OLD.state='active' AND NEW.state='reserved')
 BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_EFFECT_TRANSITION_REFUSED'); END;
CREATE TABLE native_write_effect_observations (
 effect_id TEXT NOT NULL REFERENCES native_write_effects(id),
 sequence INTEGER NOT NULL CHECK(sequence>=1),
 state TEXT NOT NULL,
 phase TEXT NOT NULL,
 evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
 materialized_identity_json TEXT CHECK(materialized_identity_json IS NULL OR json_valid(materialized_identity_json)),
 observed_at INTEGER NOT NULL,
 PRIMARY KEY(effect_id,sequence)
);
CREATE TRIGGER native_write_effect_first_observation AFTER INSERT ON native_write_effects
 BEGIN INSERT INTO native_write_effect_observations VALUES(NEW.id,1,NEW.state,NEW.phase,NEW.evidence_json,NEW.materialized_identity_json,NEW.created_at); END;
CREATE TRIGGER native_write_effect_next_observation AFTER UPDATE ON native_write_effects
 BEGIN INSERT INTO native_write_effect_observations VALUES(NEW.id,(SELECT COALESCE(MAX(sequence),0)+1 FROM native_write_effect_observations WHERE effect_id=NEW.id),NEW.state,NEW.phase,NEW.evidence_json,NEW.materialized_identity_json,NEW.updated_at); END;
CREATE TRIGGER native_write_observation_no_update BEFORE UPDATE ON native_write_effect_observations BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER native_write_observation_no_delete BEFORE DELETE ON native_write_effect_observations BEGIN SELECT RAISE(ABORT,'NATIVE_WRITE_OBSERVATION_HISTORY_REQUIRED'); END;
