# ZCode 账户模型与自定义供应商

BigModel 和 Start Plan 均可在官方桌面中提供 GLM-5.3-Flash。桌面套餐可用，不代表独立的 `app-server` 已加载账户：当前实测 ZCode 0.17.0 的该入口等待宿主提供账户信息，单独启动时可能只显示自定义供应商。不能把这个目录当成用户全部模型权益。

ProjectOrch 对受支持的账户 CLI 使用独立配置（Configuration），不读取、复制用户的认证或个人供应商配置。官方 CLI 自行使用现有登录。指定模型以外的模型被禁用；供应商或模型不可用时停止，不自动回退。

在本地数据目录的 `native-config.json` 中，保留原有字段，在 `zcodeEnv` 中添加：

```json
"PROJECTORCH_ZCODE_ACCOUNT_PROVIDER": "account:bigmodel-individual-coding-plan"
```

同时需要现有的 `ZCODE_DATA_BASE_DIR` 和 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`。后者指向官方 `zcode-builtin.json`，不能指向个人配置或认证文件。ZAI 可明确配置为 `account:zai-individual-coding-plan`；尚未做该账户的真实验证。

2026-10-31 实测通过：BigModel `GLM-5.3-Flash`，工厂创建及同一个原生 ID 的第二轮续行。模型来源由对应轮次的原生历史元数据核对；界面标注“最近已核实轮次”，不冒充 `app-server` 当前设置。没有通过读取模型回复来判断生效模型。

限制：当前官方 standalone CLI 的账户实现只覆盖 individual-coding-plan。Start Plan 虽在桌面可用，尚未验证独立 CLI 接入，不能伪造权限或转发认证解决；配置 Start Plan 会在输入前明确拒绝。显式推理等级在该账户路径也暂时拒绝，避免官方默认解析改变用户要求。自定义供应商仍走官方 RPC 选择与读回路径。

这项验证不代表十页 HTML 业务协作、所有模型或所有套餐均通过。配置文件、认证和原生会话历史均不得放入公开发布包。
