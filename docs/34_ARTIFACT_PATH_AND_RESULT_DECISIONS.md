# 产物项目路径与只读裁决增量合同

2026-10-28。理由：真实受管cwd与项目根不同，短文件名登记虽成功却无法读取/验收；负责人缺少核对持久reject的授权读取入口。只修基本闭环，不降低内容或独立复核要求。

## 产物路径（Artifact Path）

file/report的path/pathRef持久基准仍为项目canonicalRoot。执行冻结输入新增artifactContext：pathRefBase固定projectRoot，workspaceRelativeToProjectRoot为真实执行工作区的项目相对路径，项目根自身用`.`。例如cwd是项目的`.projectorch/workspaces/绑定目录`，在cwd写report.md，登记应为`.projectorch/workspaces/绑定目录/report.md`。模型不能把短文件名当项目根路径，内核不搜索同名文件、不隐式回退工作区或复制文件。

协调器在准备时计算工作区关系并冻结，工作区不在项目根内明确拒绝。Agent file/report登记在授权和归属核验后检查项目内实物、SHA-256和byteSize，错误事务不留下命令/成果；提交既有输出前再按当前task.submit_own及其路径范围检查实物，防登记后漂移。Git登记/读取/验收合同不变。

安全错误：ARTIFACT_PATH_MUST_BE_PROJECT_RELATIVE；ARTIFACT_FILE_MISSING_USE_PROJECT_RELATIVE_PATH；ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH；RESULT_OUTPUT_FILE_METADATA_REQUIRED。范围/身份拒绝仍先于文件访问。域层允许历史元数据登记的接口不变；本增量对Agent正常文件交付生效，旧artifacts/results不回填或静默改路径。

登记和提交除原pathRef授权外，在解析junction等重解析点后，读取任何文件字节之前还须按真实项目相对路径重新核对当前主体scope：登记沿用artifact.register_own，提交沿用task.submit_own，均为原write路径权限。真实目标未获准则FORBIDDEN，事务不残留登记/结果/命令；不会扩充grant。项目内真实路径也必须在角色范围内，不能仅凭词法前缀放行。

## 结果裁决视图（Result Decisions）

现有result.read请求仍仅传resultId；返回在原字段上增加decisions数组。每项包含decisionId、resultId、taskRevision（规格版本）、ruleId、decision、reviewer、createdAt、evidenceArtifactIds、evidenceRestricted、reason。来自result_rule_decisions真实持久行，不来自执行者summary。

reviewer通过服务器存储的裁决主体与历史凭据/绑定关联，还原`{kind:bound_agent,roleId}`；不能关联时明确`{kind:unresolved,roleId:null}`，不猜成用户。不返回凭据ID/token/hash或任意命令receipt。它证明谁保存此裁决，不代表该裁决自动满足独立性或内容正确。

必须先有同项目结果所属任务的task.read权限。证据逐条要求其所属任务可读及对应artifact.read路径权限；受限/缺失/跨项目证据不返回ID、路径或正文。存在受限证据时evidenceRestricted=true且reason=null，防自由文本原因带出受限引用。可读证据仍只返回ID，内容继续通过原artifact.read/content权限读取。撤销主体或跨项目结果同样拒绝，查询不写命令、事件、Outbox或业务状态。

这是现有只读工具响应的兼容增量，未新增工具/动作/权限，也未开放他人命令回执。静态类型ResultDecisionView位于agent-queries.ts；现有query.schema.json只定义请求，result.read响应此前无独立JSON Schema，本批不伪称生成了不存在的响应Schema，不改变schemaVersion=2请求或生成类型快照。任务规格、result提交、artifact登记Schema均保持。
