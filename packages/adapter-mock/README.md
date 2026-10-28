# 模拟适配器（Mock Adapter）准备实现

仅供开发期间合成事件和错误注入，没有网络、文件写入、原生附着、输入发送或可信身份能力。`provenance=synthetic`，能力声明保持 `unverified`。不写入 `config/compatibility.json`，不构成原生验证证据。

`npm run test:adapters` 构建后运行共享合同测试及模拟器故障测试。其他适配器的测试环境可以向 `tests/adapters/shared-suite.mjs` 的 `registerAdapterSuite` 提供 `{adapter, inject}` 工厂；`inject` 属于受控测试环境，不应成为生产接口。生产适配器还需要各自的真实接入、身份与故障验证。

当前只覆盖执行观察这一独立切片。`EventAdapter`、`AdapterFrame` 和纯观察归约器位于 `packages/adapter-contract/src/events.ts`，属于准备接口，不是已接受的 HTTP/SSE 事件协议。未修改固定 v2 Schema 或发布门槛。未来内核接入时必须经过合同复核和事件注册表校验。

每个连接使用新 `connectionEpoch`；序号在该连接内递增。快照可以跳号，前提是适配器已经获得完整当前状态；普通事件缺号、未知事件或执行目标冲突一律转为 `unknown` 并要求重新核对。重复、其他会话和旧代次事件不推进状态。断连不等于成功或空闲，当前执行标识继续保留。只有当前连接的有效快照才能解除核对要求；归约器不提供原生身份认证或任务验收。

T012 尚未正式准入，T016 保持 TODO；A026 保持 NOT_RUN。当前没有内核调用该切片，因此不宣称“内核行为由合同决定”已通过。
