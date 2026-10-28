-- 内部候选评估，不把准备完成写成原生执行完成；无版本旧候选明确丢弃并留记录。
CREATE TABLE workflow_evaluations (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('blocked','prepared','discarded','exhausted')),
  code TEXT NOT NULL,
  dispatch_id TEXT REFERENCES execution_dispatches(id),
  check_count INTEGER NOT NULL DEFAULT 1 CHECK(check_count>=1),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  checked_at INTEGER NOT NULL,
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),
  CHECK((decision='prepared' AND dispatch_id IS NOT NULL) OR (decision<>'prepared' AND dispatch_id IS NULL))
);
CREATE INDEX workflow_evaluations_project ON workflow_evaluations(project_id,decision);
