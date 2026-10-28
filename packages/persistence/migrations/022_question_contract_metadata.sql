-- 固定问答合同的来源及期限策略；旧问题缺字段保持NULL，不猜测超时策略或答案来源。
ALTER TABLE questions ADD COLUMN ask_command_id TEXT REFERENCES commands(id);
ALTER TABLE questions ADD COLUMN on_timeout TEXT CHECK(on_timeout IS NULL OR on_timeout IN ('raise_issue','cancel_attempt'));
ALTER TABLE questions ADD COLUMN answer_command_id TEXT REFERENCES commands(id);
ALTER TABLE questions ADD COLUMN answered_at INTEGER;
CREATE INDEX question_due ON questions(state,deadline);
CREATE TRIGGER question_contract_source BEFORE INSERT ON questions
WHEN NEW.ask_command_id IS NOT NULL AND (NEW.on_timeout IS NULL OR NOT EXISTS(
 SELECT 1 FROM commands c WHERE c.id=NEW.ask_command_id AND c.project_id=NEW.project_id AND c.type='question.ask'
)) BEGIN SELECT RAISE(ABORT,'QUESTION_COMMAND_SOURCE_MISMATCH'); END;
CREATE TRIGGER question_identity_immutable BEFORE UPDATE OF project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,answerer_role_id,prompt,deadline,ask_command_id,on_timeout ON questions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.task_id IS NOT OLD.task_id OR NEW.task_revision IS NOT OLD.task_revision
 OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_epoch IS NOT OLD.binding_epoch
 OR NEW.answerer_kind IS NOT OLD.answerer_kind OR NEW.answerer_role_id IS NOT OLD.answerer_role_id OR NEW.prompt IS NOT OLD.prompt
 OR NEW.deadline IS NOT OLD.deadline OR NEW.ask_command_id IS NOT OLD.ask_command_id OR NEW.on_timeout IS NOT OLD.on_timeout
BEGIN SELECT RAISE(ABORT,'QUESTION_IDENTITY_IMMUTABLE'); END;
