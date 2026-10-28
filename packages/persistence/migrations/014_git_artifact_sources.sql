-- 不猜测旧裸提交来自哪个仓库；新登记保存不可改写的实际仓库和对象来源。
CREATE TABLE artifact_git_sources (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_path TEXT NOT NULL CHECK(length(repository_path) BETWEEN 1 AND 2048),
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  tree_sha TEXT NOT NULL CHECK(length(tree_sha)=40 AND tree_sha NOT GLOB '*[^0-9a-f]*'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  registered_at INTEGER NOT NULL CHECK(registered_at>=0),
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id)
);
CREATE TRIGGER git_source_matches_artifact BEFORE INSERT ON artifact_git_sources
WHEN NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.id=NEW.artifact_id AND a.project_id=NEW.project_id
 AND a.path_ref='git:'||NEW.commit_sha AND a.version=NEW.commit_sha)
BEGIN SELECT RAISE(ABORT,'GIT_SOURCE_TARGET_MISMATCH'); END;
CREATE TRIGGER git_source_immutable BEFORE UPDATE ON artifact_git_sources BEGIN SELECT RAISE(ABORT,'GIT_SOURCE_IMMUTABLE'); END;
CREATE TRIGGER git_source_retained BEFORE DELETE ON artifact_git_sources BEGIN SELECT RAISE(ABORT,'GIT_SOURCE_RETAINED'); END;
