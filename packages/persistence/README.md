# 存储基础（Persistence）

`openStore(绝对路径)` 使用 Node 内置 `node:sqlite`，支持版本化迁移、校验账本、磁盘 WAL/FULL、同步短事务和连接生命周期。调用者是受信内核代码，不能把 db 或自定义 migrations 暴露为 Web/Agent 工具。

仅接受本地磁盘已有父目录；Windows 拒绝 UNC、映射网络驱动及非 Fixed 驱动，拒绝数据库符号链接和非普通文件。使用 .NET DriveInfo 只查询目标卷类型，不读取认证资料。其他平台仍需发布阶段实际验证，NFS/SMB 文件系统类型会被拒绝。

数据库实际 `sqlite_version()` 必须属于 SQLite 3 且不低于 3.51.3；不根据 Node 版本推断。当前锁定 Node 24.22.0 的 Windows x64 实测 SQLite 3.53.4；本机默认 Node 24.14.0 的 3.51.2 被拒绝。参考 [SQLite 官方 WAL 说明](https://www.sqlite.org/wal.html)。

迁移 001 固定执行包 v2 参考表与约束；002 补充原生来源审计与事件关联。迁移定义只来自可信发布件，逐项保存原始 SQL 哈希；未知用户数据库、被篡改迁移和高于应用版本的数据库均明确停止。升级已有库前通过 VACUUM INTO 在 `<database>.backups/` 创建一致性备份；升级在单次事务内完成，失败回滚并保留备份，不自动覆盖原数据库。

应用库同时保存 application_id 所有权标记和迁移账本。零版本库只有在没有任何用户 Schema 对象且没有外部应用标记时才能初始化；只有视图、非保留 sqlite 前缀表的已有库同样被拒绝，并验证拒绝前后字节不变。

`store.transaction(db => ...)` 仅允许同步回调、BEGIN IMMEDIATE 和单次提交；异常回滚，拒绝嵌套和事务中关闭。AsyncFunction 在执行前拒绝；误返回 Promise 会回滚并关闭连接，防止迟到续体继续写入。网络和模型请求必须在事务外。此 API 不是执行任意不可信 JavaScript 的沙箱，领域服务仍负责权限、DAG、路径和原生身份。

迁移器不提供自动回退到旧版本。旧程序拒绝新库；实际备份恢复和候选回滚演练由 T050/T060 完善。运行中的进程唯一性由 T019 负责，应用不能让不同版本进程并行管理同一数据库。

测试在临时独立磁盘库运行，内容全部合成，验证后核验路径并清理：

```powershell
# 使用 .node-version 锁定的 Node 24.22.0
pnpm test:integration
```

`tests/storage/crash-worker.mjs` 在状态、事件、Outbox 同一事务提交前或后写出同步标记并强制终止自身；主进程核对真实标记、异常退出和重开后的三者全无/全有。这证明进程终止恢复，不宣称已经完成断电、磁盘损坏或完整应用恢复验收。
