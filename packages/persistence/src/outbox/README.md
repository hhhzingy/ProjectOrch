# Outbox（事务发件箱）准备切片

这是 T017 的内部存储准备实现，通过 `@projectorch/persistence/outbox` 导出。它没有 HTTP、认证、真实适配器或自动发送器。不要把存储租约当成原生执行授权。

- `canonicalJson(input)`：按对象键排序，保留数组顺序，严格拒绝循环、非有限数、undefined、稀疏数组、访问器、非 JSON 对象等有损输入；深度不超过 32，UTF-8 不超过 1 MiB。它不校验业务 Schema 或可信身份。
- `enqueueOutbox(db, operation)`：必须在已有事务内调用，与命令、业务状态及事件一同提交。`operationKey` 相同且命令与规范化载荷相同，返回原 ID，不覆盖原计划时间或状态；命令或载荷不同则冲突。调用方先用可信来源、项目、绑定、规格和权限校验形成完整不可变操作载荷；本函数不能代替请求级幂等。
- `claimOutbox(store, now, leaseMs)`：在 `BEGIN IMMEDIATE` 中领取一个到期 pending 动作，递增领取代次与计数。租约最多 5 分钟。两个进程不能取得同一有效领取。时间必须来自受信内核时钟，不接受 Web/Agent 传入时间。
- `settleOutbox(...)`：只允许当前未到期代次将 dispatching 改为 delivered 或 uncertain。旧代次、已到期、已完成记录不能回写。回执作为严格 JSON 数据保存；该层不验证原生回执真实性，只有可信适配器完成对应核对后才能调用 delivered。delivered 不代表 Agent 已读或业务完成。
- `recoverExpiredOutbox(store, now)`：过期 dispatching 一律改 uncertain 并撤销旧代次，不会重新入队或重新发送。时钟跳变的保守影响也可能是提前进入 uncertain，不证明外部未执行。

外发前必须由后续 DispatchGuard 再次核对权限、暂停、目标版本、绑定和占位；数据库领取不控制原客户端，也不能撤销原生副作用。将不确定操作恢复为可重试，需要 T026 等实现持久核对和可信幂等判定，当前刻意不提供通用重发入口。续租、退避、耗尽、取消的业务策略仍待上层实现。

没有修改 Schema 或迁移，沿用 T011 的 outbox 表。测试使用独立临时本地库及合成内容，包括真实子进程竞争和真实强制终止。运行本轮测试：

```powershell
npm run build
npm exec --yes --package=node@24.22.0 -- node --test tests/storage/outbox.test.mjs
```

完整存储回归可使用锁定 Node 执行 `npm run test:integration`。默认 Node 24.14.0 嵌入的 SQLite 不符合应用 Store 要求，不应用它运行磁盘存储测试。

T012/T013 未完成，T017 仍为 TODO，A027/A028 仍为 NOT_RUN。当前没有命令入口调用该切片，也没有真实 Harness 发送；上述单项存储测试不能替代完整验收。
