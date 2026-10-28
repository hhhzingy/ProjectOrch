-- 幂等命名空间属于持久角色；保留历史命令来源/回执，不将已重复副作用合并成一次。
CREATE TABLE agent_role_sources (
  project_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  source_principal_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(project_id,role_id),
  FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id)
);
CREATE UNIQUE INDEX commands_agent_scope_target ON commands(id,project_id,request_id);
CREATE TABLE agent_command_scopes (
  command_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES agent_credentials(id),
  FOREIGN KEY(command_id,project_id,request_id) REFERENCES commands(id,project_id,request_id),
  FOREIGN KEY(project_id,role_id) REFERENCES agent_role_sources(project_id,role_id)
);
CREATE INDEX agent_commands_by_role_request ON agent_command_scopes(project_id,role_id,request_id);

INSERT INTO agent_role_sources(project_id,role_id,source_principal_id)
SELECT scope.project_id,scope.role_id,'agent-role-'||lower(hex(randomblob(16)))
FROM (SELECT DISTINCT b.project_id,b.role_id FROM commands c
 JOIN agent_credentials a ON a.id=c.source_principal_id AND a.project_id=c.project_id
 JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch) scope;
INSERT INTO agent_command_scopes(command_id,project_id,role_id,request_id,credential_id)
SELECT c.id,c.project_id,b.role_id,c.request_id,a.id FROM commands c
 JOIN agent_credentials a ON a.id=c.source_principal_id AND a.project_id=c.project_id
 JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch;

-- 历史重复键原样保留；从迁移之后，新插入不允许再制造同角色同请求的第二条命令。
CREATE TRIGGER agent_command_scope_unique BEFORE INSERT ON agent_command_scopes
WHEN EXISTS(SELECT 1 FROM agent_command_scopes s WHERE s.project_id=NEW.project_id AND s.role_id=NEW.role_id AND s.request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'AGENT_COMMAND_HISTORY_AMBIGUOUS'); END;
CREATE TRIGGER agent_command_scope_provenance BEFORE INSERT ON agent_command_scopes
WHEN NOT EXISTS(
 SELECT 1 FROM commands c
 JOIN agent_credentials a ON a.id=NEW.credential_id AND a.project_id=c.project_id
 JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch
 JOIN agent_role_sources r ON r.project_id=b.project_id AND r.role_id=b.role_id
 WHERE c.id=NEW.command_id AND c.project_id=NEW.project_id AND c.request_id=NEW.request_id AND b.role_id=NEW.role_id
 AND (c.source_principal_id=a.id OR c.source_principal_id=r.source_principal_id)
)
BEGIN SELECT RAISE(ABORT,'AGENT_COMMAND_SOURCE_MISMATCH'); END;

-- 兼容仍用旧凭据命名空间的受信内部调用；同样留下别名并受唯一请求保护。
CREATE TRIGGER legacy_agent_command_scope AFTER INSERT ON commands
WHEN EXISTS(SELECT 1 FROM agent_credentials a WHERE a.id=NEW.source_principal_id AND a.project_id=NEW.project_id)
BEGIN
 INSERT INTO agent_role_sources(project_id,role_id,source_principal_id)
 SELECT b.project_id,b.role_id,'agent-role-'||lower(hex(randomblob(16))) FROM agent_credentials a
 JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch
 WHERE a.id=NEW.source_principal_id AND a.project_id=NEW.project_id
 ON CONFLICT(project_id,role_id) DO NOTHING;
 INSERT INTO agent_command_scopes(command_id,project_id,role_id,request_id,credential_id)
 SELECT NEW.id,NEW.project_id,b.role_id,NEW.request_id,a.id FROM agent_credentials a
 JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch
 WHERE a.id=NEW.source_principal_id AND a.project_id=NEW.project_id;
END;
CREATE TRIGGER agent_role_source_immutable BEFORE UPDATE ON agent_role_sources BEGIN SELECT RAISE(ABORT,'AGENT_SOURCE_IMMUTABLE'); END;
CREATE TRIGGER agent_role_source_retained BEFORE DELETE ON agent_role_sources BEGIN SELECT RAISE(ABORT,'AGENT_SOURCE_RETAINED'); END;
CREATE TRIGGER agent_command_scope_immutable BEFORE UPDATE ON agent_command_scopes BEGIN SELECT RAISE(ABORT,'AGENT_SCOPE_IMMUTABLE'); END;
CREATE TRIGGER agent_command_scope_retained BEFORE DELETE ON agent_command_scopes BEGIN SELECT RAISE(ABORT,'AGENT_SCOPE_RETAINED'); END;
