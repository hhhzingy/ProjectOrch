-- 整合后目标、内核检查运行及独立裁决：与旧基线target_version分离，不为旧行猜填来源。
CREATE UNIQUE INDEX integration_project_identity ON integrations(id,project_id);
CREATE TABLE integration_targets (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 integration_id TEXT NOT NULL,
 integration_revision INTEGER NOT NULL CHECK(integration_revision>=1),
 task_id TEXT NOT NULL,
 task_revision INTEGER NOT NULL,
 result_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 actor_binding_id TEXT NOT NULL,
 actor_binding_epoch INTEGER NOT NULL,
 target_json TEXT NOT NULL CHECK(json_valid(target_json)),
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 created_at INTEGER NOT NULL,
 UNIQUE(id,project_id),
 UNIQUE(integration_id,project_id,integration_revision),
 FOREIGN KEY(integration_id,project_id) REFERENCES integrations(id,project_id),
 FOREIGN KEY(task_id,project_id,task_revision) REFERENCES task_revisions(task_id,project_id,revision),
 FOREIGN KEY(result_id,project_id,task_revision) REFERENCES results(id,project_id,task_revision),
 FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id),
 FOREIGN KEY(actor_binding_id,project_id,actor_binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE TABLE integration_check_runs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 integration_id TEXT NOT NULL,
 target_id TEXT NOT NULL,
 check_id TEXT NOT NULL,
 check_version TEXT NOT NULL,
 authorization_id TEXT NOT NULL REFERENCES check_definition_authorizations(id),
 command_id TEXT NOT NULL,
 parameters_sha256 TEXT NOT NULL CHECK(length(parameters_sha256)=64),
 outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
 started_at INTEGER NOT NULL,
 ended_at INTEGER NOT NULL CHECK(ended_at>=started_at),
 UNIQUE(id,project_id),
 UNIQUE(target_id,project_id,check_id,check_version),
 FOREIGN KEY(integration_id,project_id) REFERENCES integrations(id,project_id),
 FOREIGN KEY(target_id,project_id) REFERENCES integration_targets(id,project_id),
 FOREIGN KEY(project_id,check_id,check_version) REFERENCES check_definitions(project_id,id,version),
 FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id)
);
CREATE TABLE integration_reviews (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 integration_id TEXT NOT NULL,
 target_id TEXT NOT NULL,
 command_id TEXT NOT NULL UNIQUE,
 reviewer_binding_id TEXT NOT NULL,
 reviewer_binding_epoch INTEGER NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('accept','reject')),
 run_ids_json TEXT NOT NULL CHECK(json_valid(run_ids_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 repair_task_id TEXT,
 repair_task_revision INTEGER,
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(integration_id,project_id) REFERENCES integrations(id,project_id),
 FOREIGN KEY(target_id,project_id) REFERENCES integration_targets(id,project_id),
 FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id),
 FOREIGN KEY(reviewer_binding_id,project_id,reviewer_binding_epoch) REFERENCES role_bindings(id,project_id,epoch),
 FOREIGN KEY(repair_task_id,project_id,repair_task_revision) REFERENCES task_revisions(task_id,project_id,revision),
 CHECK((decision='accept' AND repair_task_id IS NULL AND repair_task_revision IS NULL) OR (decision='reject' AND repair_task_id IS NOT NULL AND repair_task_revision IS NOT NULL))
);
CREATE TRIGGER integration_target_source BEFORE INSERT ON integration_targets
WHEN NOT EXISTS (
 SELECT 1 FROM integrations i JOIN results r ON r.id=NEW.result_id AND r.project_id=NEW.project_id
 JOIN commands c ON c.id=NEW.command_id AND c.project_id=NEW.project_id
 JOIN agent_command_scopes ac ON ac.command_id=c.id AND ac.project_id=c.project_id
 JOIN role_bindings b ON b.id=NEW.actor_binding_id AND b.project_id=NEW.project_id AND b.epoch=NEW.actor_binding_epoch
 WHERE i.id=NEW.integration_id AND i.project_id=NEW.project_id AND i.task_id=NEW.task_id
 AND r.task_id=NEW.task_id AND r.task_revision=NEW.task_revision
 AND ac.role_id=b.role_id AND b.ended_at IS NULL AND c.type='integration.evaluate' AND c.state='stored'
 AND json_extract(c.payload_json,'$.integrationId')=NEW.integration_id AND json_extract(c.payload_json,'$.resultId')=NEW.result_id
 AND json_extract(NEW.target_json,'$.contentHash')=NEW.content_hash
)
BEGIN SELECT RAISE(ABORT,'INTEGRATION_TARGET_SOURCE_MISMATCH');END;
CREATE TRIGGER integration_run_source BEFORE INSERT ON integration_check_runs
WHEN NOT EXISTS (
 SELECT 1 FROM integration_targets t JOIN check_definition_authorizations a ON a.id=NEW.authorization_id
 JOIN commands c ON c.id=NEW.command_id AND c.project_id=NEW.project_id
 WHERE t.id=NEW.target_id AND t.project_id=NEW.project_id AND t.integration_id=NEW.integration_id AND t.command_id=NEW.command_id
 AND a.project_id=NEW.project_id AND a.check_id=NEW.check_id AND a.check_version=NEW.check_version
 AND c.type='integration.evaluate' AND c.state='stored'
 AND json_extract(NEW.evidence_json,'$.runId')=NEW.id AND json_extract(NEW.evidence_json,'$.targetId')=NEW.target_id
 AND json_extract(NEW.evidence_json,'$.outcome')=NEW.outcome AND json_extract(NEW.evidence_json,'$.contentHash')=t.content_hash
)
BEGIN SELECT RAISE(ABORT,'INTEGRATION_RUN_SOURCE_MISMATCH');END;
CREATE TRIGGER integration_review_source BEFORE INSERT ON integration_reviews
WHEN NOT EXISTS (
 SELECT 1 FROM integration_targets t JOIN commands c ON c.id=NEW.command_id AND c.project_id=NEW.project_id
 JOIN agent_command_scopes ac ON ac.command_id=c.id AND ac.project_id=c.project_id
 JOIN role_bindings b ON b.id=NEW.reviewer_binding_id AND b.project_id=NEW.project_id AND b.epoch=NEW.reviewer_binding_epoch
 WHERE t.id=NEW.target_id AND t.project_id=NEW.project_id AND t.integration_id=NEW.integration_id AND b.ended_at IS NULL AND ac.role_id=b.role_id
 AND c.type='integration.review' AND c.state='stored' AND json_extract(c.payload_json,'$.integrationId')=NEW.integration_id
 AND json_extract(c.payload_json,'$.targetId')=NEW.target_id AND json_extract(c.payload_json,'$.decision')=NEW.decision
)
BEGIN SELECT RAISE(ABORT,'INTEGRATION_REVIEW_SOURCE_MISMATCH');END;
CREATE TRIGGER integration_target_immutable BEFORE UPDATE ON integration_targets BEGIN SELECT RAISE(ABORT,'INTEGRATION_TARGET_IMMUTABLE');END;
CREATE TRIGGER integration_target_preserved BEFORE DELETE ON integration_targets BEGIN SELECT RAISE(ABORT,'INTEGRATION_TARGET_PRESERVED');END;
CREATE TRIGGER integration_run_immutable BEFORE UPDATE ON integration_check_runs BEGIN SELECT RAISE(ABORT,'INTEGRATION_RUN_IMMUTABLE');END;
CREATE TRIGGER integration_run_preserved BEFORE DELETE ON integration_check_runs BEGIN SELECT RAISE(ABORT,'INTEGRATION_RUN_PRESERVED');END;
CREATE TRIGGER integration_review_immutable BEFORE UPDATE ON integration_reviews BEGIN SELECT RAISE(ABORT,'INTEGRATION_REVIEW_IMMUTABLE');END;
CREATE TRIGGER integration_review_preserved BEFORE DELETE ON integration_reviews BEGIN SELECT RAISE(ABORT,'INTEGRATION_REVIEW_PRESERVED');END;
