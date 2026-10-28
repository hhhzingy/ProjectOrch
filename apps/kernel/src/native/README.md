# 受管标准输入输出通路（Managed Stdio Transport）

`StdioPeer` 仅拥有其自行启动的一个子进程，通过 JSON Lines 关联请求/响应及原生通知。此模块不是完整 Supervisor、会话适配器、认证或派发准入。

启动参数、工作目录、环境和通知处理器必须来自受信代码。环境由调用者显式提供，不默认继承凭据；不提供 attach 任意现有进程的方法。连接代次为独立随机 UUID，请求 ID 带代次和递增序号。响应不能因标题/历史相似而关联其他会话。具体 session/turn 标识仍须由适配器校验。

读取逐行 UTF-8，约束帧大小，最多 64 个待决请求。未知/迟到响应不作用于新请求；畸形关联响应、超时、退出或传输错误使待决请求返回 `uncertain` 并关闭通路，不自动重发。只有格式正确的原生 error 对象才视为明确拒绝；只暴露数值错误码和有限分类，不把原生错误正文或 stderr 内容写日志。发送前的本地拒绝标为 `not_sent`。

未知服务端请求一律返回“未注册可信处理器”，不自动批准权限/工具/认证。原生审批、工具身份路由和交互问答需另行实现，因此当前通路不能承诺完整业务执行。通知处理器同步执行，异常或误返回 Promise 均安全终止；这不是运行不可信 JavaScript 的沙箱。

关闭优先发送 EOF，2 秒无退出则终止所拥有的直接进程，随后等待实际 close，无法确认退出则返回错误。只证明直接子进程退出；尚不证明整棵子孙进程树回收或“旧内核退出后原生模型执行已经停止”。恢复前必须由未来 Supervisor 持久记录及核对原生 owner，不能仅凭新 StdioPeer 可启动就恢复派发。

`tests/adapters/stdio.test.mjs` 使用独立 Node 子进程验证 framing/关联、错误/超时、未知审批、通知与关闭失败路径，是合成合同测试。真实官方进程的实验脚本在 `spikes/managed-native/lifecycle.mjs`，结果在 `reports/native/managed-lifecycle-*.json`；不要把合成测试当真实模型生命周期验收。

上述为早期通路边界。2026-10-22当前源码已有Codex/ZCode适配器类及部分HTTP/Web，但完整启动装配、可信工具传输和业务任务自动调度仍未闭环。当前运行要求、unknown保护与兼容门控见[原生适配器运行说明](../../../../docs/25_NATIVE_ADAPTER_RUNTIME.md)；不要将模块存在等同于G1或真实产品验收。

## ZCode 官方CLI纯文本切片

2026-10-19已在专用配置档实际验证官方未修改CLI三轮文本、精确sessionId续接和持久历史读取，见 `reports/native/managed-authenticated-progress-20261019.md`。app-server自身账号供给仍未解决；不得把CLI成功写成app-server执行成功。

`ZCodeCliResultCollector`只校验每进程JSONL结果，必须目标会话匹配、完整result和正常退出共同确认；不以turn.completed名称或exit 0单独确认。结果只是原生响应观察，不是业务任务验收。`ZCodeTextProcess`使用参数数组、显式环境和禁用工具选项，单实例串行，失败后unknown不再准入；不能跨进程/实例替代持久Supervisor排他，也没有树级回收、审批/停止和可信角色工具。真实实验早于此切片，只证明官方CLI路径，当前实现另经合成测试，不冒称已用原生模型复现该实现。

后续增量：T004已通过当前受管CLI、持久占位和只读观察端原生专项。`ZCodeTextSession.attachObserver()`只读元数据，detach不结束owner；connectionEpoch区分owner，processEpoch区分每次CLI，具体原生turnId来自结果。旧原生执行源码按原哈希封存，当前状态见reports/tasks/T004.md。

`deliverText`明确拒绝queue/guide，忙时不隐式排队或抢占。`requestOwnedProcessTermination`只终止精确processEpoch的自有直接进程，旧目标不影响新运行；请求后的状态为unknown且保留占位，不称原生turn已取消。该切片与合成失败测试见reports/tasks/T006.md，完整原生控制和可信工具身份尚未验收。
