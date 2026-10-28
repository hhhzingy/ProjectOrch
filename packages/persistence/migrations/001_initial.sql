-- ProjectOrch protocol v2 design reference. T011 must turn this into versioned migrations.
-- Local constraints only: DAG, authority, native truth and path checks belong to services.
PRAGMA foreign_keys = ON;

CREATE TABLE pairing_challenges (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts>=0)
);
CREATE TABLE global_requests (
  principal_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id), state TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(principal_id,request_id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  objective TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
  user_paused INTEGER NOT NULL DEFAULT 0 CHECK (user_paused IN (0,1)),
  hold_revision INTEGER NOT NULL DEFAULT 0 CHECK (hold_revision >= 0),
  policy_revision INTEGER NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(host_id, canonical_root)
);
CREATE TABLE project_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  reason TEXT NOT NULL,
  PRIMARY KEY(project_id,revision)
);
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  parent_id TEXT,
  charter TEXT NOT NULL,
  permission_profile TEXT NOT NULL,
  permission_profile_revision INTEGER NOT NULL DEFAULT 0,
  scope_paths_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scope_paths_json)),
  startup_protocol_version INTEGER,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('enabled','paused','disabled')),
  binding_state TEXT NOT NULL CHECK (binding_state IN ('unbound','provisioning','ready','error')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE(id,project_id),
  FOREIGN KEY(parent_id,project_id) REFERENCES roles(id,project_id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE TABLE role_revisions (
  role_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(role_id,revision),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE TABLE project_bootstrap (
  project_id TEXT PRIMARY KEY REFERENCES projects(id), role_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('provisioning','ready','error')),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id),
  FOREIGN KEY(principal_id,request_id) REFERENCES global_requests(principal_id,request_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  native_conversation_id TEXT NOT NULL,
  native_workspace_id TEXT NOT NULL DEFAULT '',
  runtime_epoch TEXT,
  observed_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(observed_state IN ('idle','running','waiting_approval','offline','unknown')),
  observed_at INTEGER,
  UNIQUE(harness_id,host_id,profile_id,native_conversation_id,native_workspace_id)
);
CREATE TABLE role_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  epoch INTEGER NOT NULL CHECK(epoch >= 1),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(id,project_id),
  UNIQUE(id,project_id,epoch),
  UNIQUE(role_id,epoch),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id),
  CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX role_one_binding ON role_bindings(role_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX session_one_binding ON role_bindings(session_id) WHERE ended_at IS NULL;
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  canonical_path TEXT NOT NULL,
  base_version TEXT,
  owner_task_id TEXT,
  managed INTEGER NOT NULL CHECK(managed IN (0,1)),
  enforcement TEXT NOT NULL CHECK(enforcement IN ('enforced','advisory','unknown')),
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','unknown','retired')),
  write_paths_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(write_paths_json)),
  UNIQUE(id,project_id),
  UNIQUE(canonical_path),
  FOREIGN KEY(owner_task_id,project_id) REFERENCES tasks(id,project_id)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT,
  goal TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','ready','active','waiting','review','accepted','blocked','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  spec_revision INTEGER NOT NULL DEFAULT 0 CHECK(spec_revision >= 0),
  plan_revision INTEGER NOT NULL CHECK(plan_revision >= 0),
  acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)),
  inputs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(inputs_json)),
  outputs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outputs_json)),
  UNIQUE(id,project_id),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  prerequisite_id TEXT NOT NULL,
  required_revision INTEGER NOT NULL CHECK(required_revision >= 0),
  condition TEXT NOT NULL CHECK(condition IN ('accepted','artifact_available')),
  PRIMARY KEY(task_id,prerequisite_id,condition),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY(prerequisite_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY(prerequisite_id,project_id,required_revision) REFERENCES task_revisions(task_id,project_id,revision),
  CHECK(task_id <> prerequisite_id)
);
CREATE TABLE task_revisions (
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(task_id,project_id,revision),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id)
);
-- task_revisions.revision, attempts.task_revision and dependency.required_revision
-- denote specification revisions. tasks.revision is a separate optimistic-lock counter.
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  workspace_id TEXT,
  native_execution_id TEXT,
  execution_kind TEXT NOT NULL DEFAULT 'native' CHECK(execution_kind IN ('native','revalidation')),
  correction_count INTEGER NOT NULL DEFAULT 0 CHECK(correction_count >= 0),
  state TEXT NOT NULL CHECK(state IN ('dispatching','running','waiting_input','succeeded','failed','interrupted','unknown')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(id,project_id),
  UNIQUE(id,project_id,task_id,task_revision),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY(task_id,project_id,task_revision) REFERENCES task_revisions(task_id,project_id,revision),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch),
  FOREIGN KEY(workspace_id,project_id) REFERENCES workspaces(id,project_id)
);
CREATE UNIQUE INDEX task_one_current_attempt ON attempts(task_id)
  WHERE state IN ('dispatching','running','waiting_input','unknown');
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('stored','queued','applying','completed','uncertain','failed')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(id,project_id),
  UNIQUE(source_principal_id,request_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  to_role_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)),
  state TEXT NOT NULL CHECK(state IN ('stored','queued','sending','delivered','acknowledged','resolved','uncertain','failed','cancelled')),
  native_item_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(id,project_id),
  FOREIGN KEY(to_role_id,project_id) REFERENCES roles(id,project_id),
  FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id)
);
CREATE INDEX inbox_lookup ON messages(project_id,to_role_id,state,created_at);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  native_execution_id TEXT,
  native_command_id TEXT,
  state TEXT NOT NULL,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  FOREIGN KEY(message_id,project_id) REFERENCES messages(id,project_id),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  version TEXT NOT NULL,
  path_ref TEXT NOT NULL,
  sha256 TEXT,
  byte_size INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  UNIQUE(id,project_id),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id)
);
CREATE TABLE results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','inconclusive')),
  outputs_json TEXT NOT NULL CHECK(json_valid(outputs_json)),
  summary TEXT NOT NULL,
  eligibility TEXT NOT NULL DEFAULT 'current' CHECK(eligibility IN ('current','stale','disputed')),
  source_result_id TEXT,
  UNIQUE(id,project_id),
  UNIQUE(id,project_id,task_revision),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY(source_result_id,project_id) REFERENCES results(id,project_id),
  FOREIGN KEY(attempt_id,project_id,task_id,task_revision) REFERENCES attempts(id,project_id,task_id,task_revision)
);
CREATE TABLE acceptances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','reject','needs_evidence')),
  reviewer_principal_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(result_id,project_id,task_revision) REFERENCES results(id,project_id,task_revision)
);
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  owner_role_id TEXT,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','assigned','deciding','applying','monitoring','resolved','escalated')),
  revision INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY(owner_role_id,project_id) REFERENCES roles(id,project_id),
  UNIQUE(id,project_id)
);
CREATE TABLE changesets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  command_id TEXT NOT NULL UNIQUE,
  case_id TEXT,
  expected_plan_revision INTEGER NOT NULL,
  operations_json TEXT NOT NULL CHECK(json_valid(operations_json)),
  state TEXT NOT NULL CHECK(state IN ('proposed','accepted','applying','applied','failed','conflict')),
  FOREIGN KEY(case_id,project_id) REFERENCES cases(id,project_id),
  FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id)
);
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  target_version TEXT NOT NULL,
  artifacts_json TEXT NOT NULL CHECK(json_valid(artifacts_json)),
  checks_json TEXT NOT NULL CHECK(json_valid(checks_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','integrating','verified','failed')),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id)
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL,
  causation_id TEXT,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX event_stream ON events(project_id,sequence);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(id),
  operation_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','delivered','uncertain','exhausted','cancelled')),
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  native_receipt_json TEXT CHECK(native_receipt_json IS NULL OR json_valid(native_receipt_json))
);
CREATE INDEX outbox_ready ON outbox(state,next_attempt_at);
CREATE TABLE transcript_items (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  native_item_id TEXT NOT NULL,
  native_revision TEXT NOT NULL,
  visible_json TEXT NOT NULL CHECK(json_valid(visible_json)),
  PRIMARY KEY(session_id,native_item_id)
);
CREATE TABLE native_cursors (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  epoch TEXT,
  cursor TEXT,
  snapshot_revision TEXT,
  observed_at INTEGER NOT NULL
);

-- Below are local integrity constraints; policy/DAG/path and real provenance checks
-- remain mandatory domain-service responsibilities, not claims of implementation.
CREATE TABLE policy_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  authorized_user_id TEXT NOT NULL,
  PRIMARY KEY(project_id,revision)
);
CREATE TABLE check_definitions (
  project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, version TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY(project_id,id,version)
);
CREATE TABLE check_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, result_id TEXT NOT NULL,
  check_id TEXT NOT NULL, check_version TEXT NOT NULL, target_spec_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','not_run')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(result_id,project_id) REFERENCES results(id,project_id),
  FOREIGN KEY(project_id,check_id,check_version) REFERENCES check_definitions(project_id,id,version)
);
CREATE TABLE questions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  answerer_kind TEXT NOT NULL CHECK(answerer_kind IN ('user','role')), answerer_role_id TEXT,
  prompt TEXT NOT NULL, answer TEXT, deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','answered','expired','cancelled')),
  UNIQUE(id,project_id),
  CHECK((answerer_kind='role' AND answerer_role_id IS NOT NULL) OR (answerer_kind='user' AND answerer_role_id IS NULL)),
  FOREIGN KEY(attempt_id,project_id,task_id,task_revision) REFERENCES attempts(id,project_id,task_id,task_revision),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch),
  FOREIGN KEY(answerer_role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE TABLE waits (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL, binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  target_json TEXT NOT NULL CHECK(json_valid(target_json)), deadline INTEGER NOT NULL,
  on_timeout TEXT NOT NULL CHECK(on_timeout IN ('raise_issue','cancel_attempt')),
  state TEXT NOT NULL CHECK(state IN ('waiting','resolved','expired','cancelled','stale')),
  FOREIGN KEY(attempt_id,project_id,task_id,task_revision) REFERENCES attempts(id,project_id,task_id,task_revision),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE UNIQUE INDEX attempt_one_wait ON waits(attempt_id) WHERE state='waiting';
CREATE TABLE goal_holds (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('authenticated_user','role_forwarded','native_unverified','kernel')),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  affected_tasks_json TEXT NOT NULL CHECK(json_valid(affected_tasks_json)),
  scope_known INTEGER NOT NULL CHECK(scope_known IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('pending','resolved','awaiting_user'))
);
CREATE TABLE workspace_reservations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, fence INTEGER NOT NULL CHECK(fence>=1),
  state TEXT NOT NULL CHECK(state IN ('reserved','unknown','released')),
  FOREIGN KEY(workspace_id,project_id) REFERENCES workspaces(id,project_id),
  FOREIGN KEY(task_id,project_id,task_revision) REFERENCES task_revisions(task_id,project_id,revision)
);
CREATE UNIQUE INDEX workspace_one_writer ON workspace_reservations(workspace_id) WHERE state IN ('reserved','unknown');
CREATE TABLE handovers (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  from_binding_epoch INTEGER NOT NULL, plan_revision INTEGER NOT NULL,
  package_json TEXT NOT NULL CHECK(json_valid(package_json)), verifier_role_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','verified','consumed','stale')),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id),
  FOREIGN KEY(verifier_role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE TRIGGER revised_spec_stales_results AFTER UPDATE OF spec_revision ON tasks
WHEN NEW.spec_revision <> OLD.spec_revision
BEGIN UPDATE results SET eligibility='stale' WHERE task_id=NEW.id AND task_revision<>NEW.spec_revision; END;
CREATE TRIGGER late_result_is_stale AFTER INSERT ON results
WHEN NEW.task_revision<>(SELECT spec_revision FROM tasks WHERE id=NEW.task_id)
BEGIN UPDATE results SET eligibility='stale' WHERE id=NEW.id; END;
CREATE TRIGGER accept_current_spec BEFORE INSERT ON acceptances
WHEN NEW.decision='accept' AND EXISTS (
  SELECT 1 FROM results r JOIN tasks t ON r.task_id=t.id
  WHERE r.id=NEW.result_id AND (r.task_revision<>t.spec_revision OR r.eligibility<>'current')
)
BEGIN SELECT RAISE(ABORT,'STALE_SPEC'); END;
