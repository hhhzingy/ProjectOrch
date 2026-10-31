# ProjectOrch 0.1.0-alpha.3

本地多Harness协作内核（Local Kernel）：AI在Codex、ZCode聊天中通过MCP建立角色、分工和交互；用户主要监督任务、模型与进度，在Web答题、调整偏好或暂停。

许可证：[Apache-2.0](LICENSE)。维护者：hhhzingy。目标：[ProjectOrch](https://github.com/hhhzingy/ProjectOrch)。用户已授权完成Alpha后公开发布。基本Alpha子集已独立验收；完整85任务路线尚未完成。本包构建时尚未公开，实际上线以仓库Release记录为准。

## 能力与验证边界

- 角色、任务、持久消息/问答、具名成果、指定独立复核及返工合同已有实现和离线正反测试，Web保留监督与模型偏好等轻操作。
- 官方客户端保持原样。只对[支持摘要](docs/SUPPORT_STATUS.json)中精确版本/二进制的有据低层textInput/resume/historyRead/roleTools提供能力数据；漂移继续拒绝相关写入。
- 三角色入口：Codex负责人、ZCode执行、Codex独立复核。控制聊天不自动冒充受管负责人，Codex当前默认只读。
- 文件按项目相对真实路径和当前权限核验实物/hash/大小，负责人可读有权限的持久裁决。额度错误保留安全分类，不自动重试或清unknown。

已验Alpha子集：19dc第一项目的真实问答、文件、独立退回、同会话修复、验收与后继链；1eb独立第二项目的文件测试、指定复核、accepted后继、负责人验收和普通重启身份保持。两次使用不同源码检查点，适用差异为已审4处安全诊断透传；不称为同一hash连续两次测试。低层支持不等于完整验收、全部模型权益或额度保证。

## 本地启动

Windows普通用户、Node.js 24.22.0。源码不含运行时/Harness；Windows ZIP附带运行时。依次运行：

1. npm ci --ignore-scripts
2. npm run build
3. npm run typecheck
4. npm run test:offline
5. npm run start:kernel -- --data-dir E:\ProjectOrchData --pair

用实际启动地址和本次配对信息进入Web，按[首次使用](docs/user/ALPHA_FIRST_USE.md)配置官方程序及MCP。已测试版本只供参考，不设置版本白名单；运行仍遵守用户项目策略、权限、预算及真实接口结果，不能手改verified或SQLite冒称已测试。按[三角色示例](examples/three-role/README.md)建立团队；严格模型请求不支持时停发。

查看[限制](docs/user/ALPHA_KNOWN_ISSUES.md)、[停止恢复](docs/user/WINDOWS_CANDIDATE_GUIDE.md)、[发布说明](RELEASE_NOTES.md)、[第三方许可](THIRD_PARTY_NOTICES.md)。私密漏洞报告入口尚未实际启用，不造邮箱，不公开上传敏感材料。

## 溯源与发布

SOURCE_MANIFEST.json记录各文件和上游源码hash；产品逻辑保持上游字节，许可/版本/干净文档和支持数据是明确变换。排除私有planning/reports、认证、聊天、数据库、截图和work，不继承内部DONE/PASS。CI模板不是云CI已运行的证明。基本Alpha子集的原生验收已独立确认；最终公开件由负责人核对后按既有授权发布。

最小持续集成（CI）命令：`npm ci --ignore-scripts` → `npm run build` → `npm run typecheck` → `npm run test:offline`，Node.js 24.22.0、Windows、PROJECTORCH_NATIVE_TESTS=0。仓库工作流使用固定Action提交；本地验证不冒称云CI已运行。


alpha.3：指定模型可用于新会话首轮，选择失败不回落默认模型。首轮ZCode采用空会话→官方模型设置/读回→同ID执行章程。模型权益及网络失败据实报告，不承诺任意模型可用。
