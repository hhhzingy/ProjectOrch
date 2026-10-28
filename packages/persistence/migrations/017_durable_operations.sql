-- DR02/DR01（PR2修复）：持久分步操作表 + 控制入口主体表。
-- durable_operations：编排操作的操作ID/幂等键/步骤/状态/载荷（查询进度/恢复/取消的数据源）。
-- control_entries：控制入口主体的权限清单（凭据哈希在agent_credentials）。
CREATE TABLE IF NOT EXISTS durable_operations (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','running','observed','unknown','failed','cancelled')),
  steps_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(steps_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_entries (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  project_id TEXT NOT NULL,
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
