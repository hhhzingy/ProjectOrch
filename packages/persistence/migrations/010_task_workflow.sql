-- 旧握手不猜测回填；新任务领取必须有完整持久版本锚点。
CREATE TABLE role_startup_acks (
  binding_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  role_revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  task_specs_json TEXT NOT NULL CHECK(json_valid(task_specs_json)),
  acknowledged_at INTEGER NOT NULL,
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE TABLE task_reports (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  binding_epoch INTEGER NOT NULL,
  report TEXT NOT NULL,
  wait_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id),
  FOREIGN KEY(attempt_id,project_id,task_id,task_revision) REFERENCES attempts(id,project_id,task_id,task_revision)
);
-- 各规则的中间裁决独立保存，全部满足后才生成最终acceptance。
CREATE TABLE result_rule_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','reject','needs_evidence')),
  reviewer_principal_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(result_id,project_id,task_revision) REFERENCES results(id,project_id,task_revision)
);
CREATE INDEX result_rule_history ON result_rule_decisions(project_id,result_id,rule_id);
CREATE TABLE external_conditions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK(revision>=0),
  verifier_role_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','verified','rejected')),
  FOREIGN KEY(verifier_role_id,project_id) REFERENCES roles(id,project_id)
);
