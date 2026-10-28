-- 可信用户注册来源；历史裸定义不补造授权，不自动取得生产运行资格。
CREATE TABLE check_definition_authorizations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 check_id TEXT NOT NULL,
 check_version TEXT NOT NULL,
 command_id TEXT NOT NULL UNIQUE,
 authorized_user_id TEXT NOT NULL,
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 FOREIGN KEY(project_id,check_id,check_version) REFERENCES check_definitions(project_id,id,version),
 FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id)
);
CREATE INDEX check_authorization_current ON check_definition_authorizations(project_id,check_id,check_version,created_at);
CREATE TRIGGER check_authorization_source BEFORE INSERT ON check_definition_authorizations
WHEN NOT EXISTS (
 SELECT 1 FROM commands c WHERE c.id=NEW.command_id AND c.project_id=NEW.project_id
 AND c.type='check.register' AND c.state='stored' AND c.source_principal_id=NEW.authorized_user_id
 AND json_extract(c.payload_json,'$.definition.id')=NEW.check_id
 AND json_extract(c.payload_json,'$.definition.version')=NEW.check_version
 AND json_extract(c.payload_json,'$.definition')=NEW.definition_json
)
BEGIN SELECT RAISE(ABORT,'CHECK_AUTHORIZATION_SOURCE_MISMATCH');END;
CREATE TRIGGER check_authorization_immutable BEFORE UPDATE ON check_definition_authorizations
BEGIN SELECT RAISE(ABORT,'CHECK_AUTHORIZATION_IMMUTABLE');END;
CREATE TRIGGER check_authorization_preserved BEFORE DELETE ON check_definition_authorizations
BEGIN SELECT RAISE(ABORT,'CHECK_AUTHORIZATION_PRESERVED');END;
