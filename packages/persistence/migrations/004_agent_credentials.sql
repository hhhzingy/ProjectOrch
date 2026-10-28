-- 仅供可信内核为已隔离的原生连接颁发；原始凭据不进入数据库。
CREATE TABLE agent_credentials (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK(binding_epoch>=1),
  session_key_hash TEXT NOT NULL CHECK(length(session_key_hash)=64),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
) STRICT;
CREATE INDEX agent_credentials_by_binding ON agent_credentials(binding_id,binding_epoch);
