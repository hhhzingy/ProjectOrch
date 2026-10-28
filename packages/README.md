# 共享包边界

已实现 `runtime/` 工程运行时检查与应用版本信息，以及 `persistence/` 真实数据库迁移、事务和连接基础，详见该包说明与 T011 报告。

`adapter-contract/` 已准备 SessionRef 结构合同；`contracts/` 已准备固定 Schema 类型与边界校验。它们不代表原生身份或 T002/T012 已验收，见实际任务状态。

后续按任务建立 `adapter-contract/`（T002）、`contracts/`（T012）、`domain/`（业务规则）、`persistence/`（T011）、`adapters/` 与 `gateway/`；这些目录尚未代表已实现模块。共享合同与迁移由同一执行者维护，不能让界面直接写数据库。
