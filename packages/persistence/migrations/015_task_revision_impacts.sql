-- 保存修订影响，旧记录不猜测回填；新规格才可重新提交并裁决。
CREATE TABLE task_revision_impacts (
  project_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  source_spec_revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_spec_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id,source_task_id,source_spec_revision,task_id,task_spec_revision),
  FOREIGN KEY(source_task_id,project_id,source_spec_revision) REFERENCES task_revisions(task_id,project_id,revision),
  FOREIGN KEY(task_id,project_id,task_spec_revision) REFERENCES task_revisions(task_id,project_id,revision)
) STRICT;
CREATE INDEX revision_impacts_target ON task_revision_impacts(project_id,task_id,task_spec_revision);
CREATE TRIGGER revision_impacts_immutable_update BEFORE UPDATE ON task_revision_impacts
BEGIN SELECT RAISE(ABORT,'REVISION_IMPACT_IMMUTABLE'); END;
CREATE TRIGGER revision_impacts_immutable_delete BEFORE DELETE ON task_revision_impacts
BEGIN SELECT RAISE(ABORT,'REVISION_IMPACT_IMMUTABLE'); END;
CREATE TRIGGER revision_impact_stales_results AFTER INSERT ON task_revision_impacts
BEGIN
  UPDATE results SET eligibility='stale' WHERE project_id=NEW.project_id AND task_id=NEW.task_id AND task_revision=NEW.task_spec_revision;
END;
CREATE TRIGGER impacted_late_result_is_stale AFTER INSERT ON results
WHEN EXISTS(SELECT 1 FROM task_revision_impacts i WHERE i.project_id=NEW.project_id AND i.task_id=NEW.task_id AND i.task_spec_revision=NEW.task_revision)
BEGIN UPDATE results SET eligibility='stale' WHERE id=NEW.id; END;
CREATE TRIGGER impacted_spec_cannot_be_accepted BEFORE INSERT ON acceptances
WHEN NEW.decision='accept' AND EXISTS(
  SELECT 1 FROM task_revision_impacts i JOIN results r ON r.project_id=i.project_id AND r.task_id=i.task_id AND r.task_revision=i.task_spec_revision
  WHERE r.id=NEW.result_id AND r.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'TASK_SPEC_REVALIDATION_REQUIRED'); END;
