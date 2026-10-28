# 固定合同与边界校验（Contracts）

这是 T012 可独立准备的代码；T002 真实身份前置尚未通过，T012 未结项，A019 尚未声明 PASS。

权威 Schema 仍位于根目录 contracts/schemas/。`contracts:generate` 用固定 json-schema-to-typescript 16.0.0 生成 TypeScript 类型及带 SHA-256 的运行时快照；解析器只解析仓库内已登记 ID，禁用 HTTP 和文件外部引用解析。实现使用依赖的 [官方生成接口](https://github.com/bcherny/json-schema-to-typescript)。`contracts:check` 比对生成内容，类型检查和构建会先执行一致性检查，不自动接受已漂移的生成物。

运行时使用 AJV 2020-12 固定注册表；拒绝未知 Schema 名称、危险未知字段、旧协议版本和不合法 JSON。返回输入副本；不接受调用方提供执行 Schema/SQL/可信主体。错误仅含固定原因及最多16条结构路径，不回显输入数据。类型不能表达的范围、条件和授权仍需运行时/领域服务检查。

生成器将无属性且禁止额外字段的对象映射为 Record<string, never>，避免 TypeScript 的 {} 类型接受原始值。Biome 仅在生成的 Schema 数据文件中豁免 noThenProperty：then 是 JSON Schema 固定关键字，不是可执行 thenable；业务源码仍保留此检查。

`negotiateProtocol` 只选择实际实现的 v2 交集；不兼容时返回使用既有 VALIDATION_ERROR 码的 ContractError，并给 UNSUPPORTED_PROTOCOL_VERSION 原因。没有扩充公共错误码或静默兼容 v1。

`negotiateAdapter` 校验能力声明与必需能力；未知、unverified、unsupported 或缺少证据引用的 verified 声明拒绝。它只验证声明结构，不认证声明者或验证原生事实；实际证据、可信主机身份及 G1 仍由绑定与准入服务核验。合成的“证据引用”绝不构成 native PASS。

```powershell
pnpm contracts:generate
pnpm contracts:check
pnpm typecheck
pnpm test:contracts
```

测试覆盖全部合同正反例、静态类型拒绝、协议交集、未知能力、自报身份/Schema/SQL、JSON 边界和不回显敏感输入。真实旧客户端/新服务联调与原生握手尚未完成；本套件不可替代它们。
