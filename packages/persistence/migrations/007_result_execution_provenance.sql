-- 结果资格同时取决于规格、绑定和执行尝试。已作出的验收历史不被静默改写。
CREATE TRIGGER ended_binding_stales_unaccepted_results AFTER UPDATE OF ended_at ON role_bindings
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
BEGIN
  UPDATE results SET eligibility='stale'
  WHERE attempt_id IN (SELECT id FROM attempts WHERE binding_id=NEW.id AND project_id=NEW.project_id)
    AND NOT EXISTS (SELECT 1 FROM acceptances c WHERE c.result_id=results.id AND c.project_id=results.project_id AND c.decision='accept');
END;
CREATE TRIGGER new_attempt_stales_unaccepted_results AFTER INSERT ON attempts
BEGIN
  UPDATE results SET eligibility='stale'
  WHERE project_id=NEW.project_id AND task_id=NEW.task_id AND task_revision=NEW.task_revision
    AND attempt_id IN (SELECT id FROM attempts WHERE rowid<NEW.rowid AND project_id=NEW.project_id AND task_id=NEW.task_id AND task_revision=NEW.task_revision)
    AND NOT EXISTS (SELECT 1 FROM acceptances c WHERE c.result_id=results.id AND c.project_id=results.project_id AND c.decision='accept');
END;
CREATE TRIGGER result_execution_must_be_current AFTER INSERT ON results
WHEN EXISTS (
  SELECT 1 FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id
  WHERE a.id=NEW.attempt_id AND a.project_id=NEW.project_id
    AND (b.ended_at IS NOT NULL OR b.epoch<>a.binding_epoch OR EXISTS (
      SELECT 1 FROM attempts newer WHERE newer.project_id=a.project_id AND newer.task_id=a.task_id AND newer.task_revision=a.task_revision AND newer.rowid>a.rowid
    ))
)
BEGIN UPDATE results SET eligibility='stale' WHERE id=NEW.id; END;
CREATE TRIGGER acceptance_requires_current_execution BEFORE INSERT ON acceptances
WHEN NEW.decision='accept' AND NOT EXISTS (
  SELECT 1 FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id
  JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch
  WHERE r.id=NEW.result_id AND r.project_id=NEW.project_id AND a.state='succeeded' AND b.ended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM attempts newer WHERE newer.project_id=a.project_id AND newer.task_id=a.task_id AND newer.task_revision=a.task_revision AND newer.rowid>a.rowid)
)
BEGIN SELECT RAISE(ABORT,'RESULT_EXECUTION_NOT_CURRENT'); END;
-- 升级只使尚未验收的失效记录过期，保留用户原始数据和已验收历史。
UPDATE results SET eligibility='stale'
WHERE NOT EXISTS (SELECT 1 FROM acceptances c WHERE c.result_id=results.id AND c.project_id=results.project_id AND c.decision='accept')
  AND EXISTS (
    SELECT 1 FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id
    WHERE a.id=results.attempt_id AND a.project_id=results.project_id
      AND (b.ended_at IS NOT NULL OR b.epoch<>a.binding_epoch OR EXISTS (
        SELECT 1 FROM attempts newer WHERE newer.project_id=a.project_id AND newer.task_id=a.task_id AND newer.task_revision=a.task_revision AND newer.rowid>a.rowid
      ))
  );
