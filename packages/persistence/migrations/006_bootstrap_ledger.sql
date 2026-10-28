-- T067：project_bootstrap 的 (principal_id,request_id) 外键指向 global_requests 台账，
-- 而该台账由命令完成侧写入（v0.1管线未写）。首次接入的幂等由命令管线 replay 与本表自身
-- (principal_id,request_id) 列保证，故重建本表去除对未写台账的前置依赖；数据原样迁移。
CREATE TABLE project_bootstrap_rebuilt (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  role_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('provisioning','ready','error')),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id)
);
INSERT INTO project_bootstrap_rebuilt(project_id,role_id,principal_id,request_id,state) SELECT project_id,role_id,principal_id,request_id,state FROM project_bootstrap;
DROP TABLE project_bootstrap;
ALTER TABLE project_bootstrap_rebuilt RENAME TO project_bootstrap;
