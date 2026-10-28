# 首次使用

## 安装与原生配置

按README安装固定依赖、构建，使用独立数据目录启动并在浏览器配对。源码需要Node.js 24.22.0；如使用另行交付的Windows候选ZIP，其运行时和第三方许可随包附带。普通用户运行，不需要管理员权限。

复制 `docs/config-samples/native-config.example.json` 到数据目录的 `native-config.json`，把所有占位路径换成已安装的官方程序；只配置具备的Harness。官方程序正常登录；Codex共享现有登录须显式选择sharedLogin，不复制认证文件。样例executionTimeoutMs=900000是整个原生轮执行期限（默认15分钟、最多30分钟）；timeoutMs为旧兼容别名，显式240000仍为240秒，两字段不一致在外发前拒绝。Codex rpcTimeoutMs独立默认20秒、最多60秒，不随执行期限扩大。这些均不扩大任务、账号、次数或项目/总窗口预算。

先核对 安装/源码根目录下docs/SUPPORT_STATUS.json 的精确官方版本/二进制和低层逐能力范围。匹配身份有据能力可用于正常授权的受管执行；不匹配或更新后身份仍拒绝相关写动作。基本Alpha子集已独立验收，完整路线仍未完成，已验证范围和限制以支持摘要为准。不将模板哈希改成当前程序哈希就宣称支持；由维护者按实际官方受支持接口验证并发布适用证据。升级后再次核对，不修改客户端或绕过身份闸。

## MCP与三角色

在控制Harness配置 `docs/config-samples/codex-mcp-entry.toml` 或 `zcode-mcp-entry.json`。stdio桥从所选数据目录的发现文件读取当前地址，避免重启端口变化；路径换成当前安装目录和Node路径。令牌只保存在用户本机，不能写进需求、截图或公开仓库。

先调用projectorch_identity核对控制入口，在Web新建项目，选择Codex负责人/ZCode执行/Codex复核，明确确认工作目录、职责、权限、并发及现有预算。创建后复制生成指令给已连接MCP的Harness；它调用project_bootstrap并查询原operationId，全部ready后才向负责人发一次业务目标。控制聊天本身不自动绑定为负责人；模板会创建新受管会话。

手动模式默认禁用原生。不能靠保存模型偏好开启旧项目的自动执行；需要用户明确策略。实际支持范围以安装环境验证为准。Codex当前受管默认只读，执行文件由ZCode完成，Codex核对真实成果后保存独立summary/裁决；引用已核对输入文件不冒称自写报告。

## 日常监督

Web可看角色、Harness、模型偏好和有效观察、当前任务/等待原因、成果与下一动作；可保存模型偏好、暂停/恢复及回答指定用户问题。偏好生效需安全轮次和真实能力，不强行切换在途会话。

角色详情只读正文按当前绑定读取，手动刷新，每页30条，快照5分钟有效，最多200条；长文本截断，完整历史回原生Harness查看。网络/能力失败保留可见旧记录并报告，不把旧记录当最新终态。

任务执行先task.read；draft/ready先按当前entity revision和specRevision认领同一attempt，再读active后提问/登记/提交。原生attempt running本身不等于业务任务已领取。question.ask须业务成功返回真实questionId后才report.wait，不能把工具传输completed当业务成功。

未知外部结果按[运行与恢复](WINDOWS_CANDIDATE_GUIDE.md)保留原ID核对。不要重发未知消息、再建替代团队、清锁或用数据库改写绕过。关闭/重启保持数据目录和项目，卸载只删除自己安装的程序目录，不删除用户项目/数据/官方历史。
