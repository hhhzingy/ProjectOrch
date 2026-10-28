-- 请求停止与原生已停止分离；保持attempt占位直到可信终态核对。
CREATE TABLE native_control_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK(binding_epoch>=1),
  expected_native_execution_id TEXT,
  task_spec_revision INTEGER NOT NULL CHECK(task_spec_revision>=0),
  kind TEXT NOT NULL CHECK(kind='stop'),
  state TEXT NOT NULL CHECK(state IN ('pending','requested','confirmed','uncertain','rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE(attempt_id,task_spec_revision,kind),
  FOREIGN KEY(attempt_id,project_id) REFERENCES attempts(id,project_id),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
) STRICT;
