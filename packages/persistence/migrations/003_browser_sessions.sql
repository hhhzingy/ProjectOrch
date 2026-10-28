-- 浏览器凭据与CSRF原值不入库；principal_id来自受信本地用户身份配置。
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT;
CREATE INDEX browser_sessions_by_principal ON browser_sessions(principal_id,expires_at);
