-- 旧成果不能猜测属于当前规格；旧artifact_available依赖缺outputName时保持待核对。
ALTER TABLE artifacts ADD COLUMN task_revision INTEGER CHECK(task_revision IS NULL OR task_revision >= 0);
ALTER TABLE task_dependencies ADD COLUMN output_name TEXT CHECK(output_name IS NULL OR length(output_name) BETWEEN 1 AND 128);
CREATE INDEX artifact_task_spec ON artifacts(project_id,task_id,task_revision);
CREATE TRIGGER artifact_spec_must_exist BEFORE INSERT ON artifacts
WHEN NEW.task_revision IS NOT NULL AND (NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM task_revisions WHERE task_id=NEW.task_id AND project_id=NEW.project_id AND revision=NEW.task_revision
))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_SPEC_NOT_FOUND'); END;
CREATE TRIGGER artifact_provenance_immutable BEFORE UPDATE ON artifacts
WHEN NEW.task_revision IS NOT OLD.task_revision OR NEW.task_id IS NOT OLD.task_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.version IS NOT OLD.version OR NEW.path_ref IS NOT OLD.path_ref OR NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size
BEGIN SELECT RAISE(ABORT,'ARTIFACT_IMMUTABLE'); END;
