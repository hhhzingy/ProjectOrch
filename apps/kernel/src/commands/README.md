# 内部命令管线准备实现

`createCommandRunner(store, {authorize, handlers})` 将严格 v2 合同校验、当前权限核验、请求级幂等、领域处理及首次回执保存放入同步事务。它是 T017 的准备组件，未从 `main.ts` 启动，没有 HTTP、配对或真实身份认证入口，也没有注册生产领域处理器。

调用者必须来自可信启动代码：`principalId` 由未来认证层提供，不能从请求正文提取。`authorize` 是必须显式注入的受信同步实现，必须核验当前主体、项目和动作权限；没有默认放行，即使返回旧回执也先做权限检查。测试中固定主体和布尔授权仅为合成夹具，不能接入生产。

`handlers` 初始化时复制到内部注册表，只允许受信代码提供。领域处理器负责当前 revision/specRevision、项目归属、状态机、暂停、预算和其他业务不变量；可以在给定事务内写状态、事件及 Outbox，最后返回符合既有 Receipt 定义的回执。只有未知副作用确定可重试后才能恢复，事务内不能发网络/模型请求。未注册新命令拒绝执行，但已处理且当前有权读取的同内容请求仍可返回原回执。

AsyncFunction 在构造时拒绝。普通函数意外返回 Promise，会交给 Store 回滚并关闭连接，阻止异步续体迟到写入。该机制不能把任意恶意回调变成安全代码；授权器和处理器都属于受信应用实现，绝不能由 Web/Agent 提供。

请求日志位于 `@projectorch/persistence/commands`：`reserveCommand` 和 `commitCommandReceipt` 必须在同一领域事务内使用。直接使用低层函数的调用者也必须先完成认证和每次权限检查。`reserveCommand` 不能代替认证，也不应单独提交；已经单独提交的无回执行保守报 COMMAND_INCOMPLETE，不重复业务动作。

稳定摘要包含整个严格 v2 请求（包含项目、动作、载荷和请求 ID），作用域是主体与请求 ID。同键异内容/跨项目/与项目创建全局键冲突均拒绝。回执由已有领域 Schema 的固定 `receipt` 入口校验，关联命令、项目、请求、错误请求 ID 及事务内当前项目事件序号；首次接受 stored/queued/completed/failed，stored 也必须有持久回执才能重放。后续 applying/uncertain 等状态和回执应由专门服务同步更新，当前没有实现这些更新入口。

T012/T013 未完成，真实认证、领域动作、统一派发与恢复尚未集成，T017/A027/A028 不因此结项。测试 `journal-fixture.mjs` 的状态修改和 revision 检查属于独立合成领域动作，不是生产 project.resume 行为。
