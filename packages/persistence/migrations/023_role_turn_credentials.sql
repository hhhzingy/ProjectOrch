-- 只对本内核签发的角色工具凭据限定执行尝试，不读取Harness认证材料。
CREATE TABLE role_turn_credentials (
 credential_id TEXT PRIMARY KEY REFERENCES agent_credentials(id),
 project_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 binding_epoch INTEGER NOT NULL,
 FOREIGN KEY(attempt_id,project_id) REFERENCES attempts(id,project_id),
 FOREIGN KEY(binding_id,project_id,binding_epoch) REFERENCES role_bindings(id,project_id,epoch)
);
CREATE TRIGGER role_turn_scope_immutable BEFORE UPDATE ON role_turn_credentials
BEGIN SELECT RAISE(ABORT,'ROLE_TURN_SCOPE_IMMUTABLE'); END;
