// 组件测试专用：显式播种由合成用户授权的持久策略，不以dispatcher参数冒充授权。
export function installSyntheticPolicy(store, projectId, profiles) {
  store.transaction(db => {
    const row = db.prepare('SELECT policy_json,policy_revision FROM projects WHERE id=?').get(projectId);
    const old = JSON.parse(row.policy_json);
    const revision = old.profiles ? Number(row.policy_revision) + 1 : Number(row.policy_revision);
    const policy = { id: 'synthetic-policy', revision, profiles, limits: { totalConcurrency: 4, roleConcurrency: 1, maxAttempts: 8, maxCorrectionTurns: 2, maxManagementRounds: 3, maxDynamicRoles: 4, wallTimeMs: 3600000, costCeiling: null, costEnforcement: 'unavailable' }, nativeMode: 'verified_only', writeIsolation: 'exclusive_workspace' };
    db.prepare('UPDATE projects SET policy_json=?,policy_revision=? WHERE id=?').run(JSON.stringify(policy), revision, projectId);
    db.prepare('INSERT INTO policy_revisions(project_id,revision,policy_json,authorized_user_id) VALUES(?,?,?,?)').run(projectId, revision, JSON.stringify(policy), 'synthetic-user');
    for (const profile of profiles) db.prepare('UPDATE roles SET permission_profile_revision=? WHERE project_id=? AND permission_profile=?').run(profile.revision, projectId, profile.id);
  });
}
