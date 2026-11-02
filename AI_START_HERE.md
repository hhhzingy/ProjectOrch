# 给接手 AI：从这里开始

你的任务是帮助用户安装、配置和使用 ProjectOrch。先读 [AI 安装与使用手册](docs/user/AI_INSTALL_AND_USE.md)，需要整段指令时读 [可复制提示词](docs/user/AI_PROMPTS.md)。这两个文件同时随源码和 Windows ZIP 提供。

1. 确认当前是 Windows ZIP 还是源码；不要把维护者电脑路径当依赖。ZIP 使用自带 `runtime/node.exe`，源码先安装固定依赖并构建。
2. 用 `scripts/setup.mjs discover --json` 找候选入口；多个候选不能盲选。用 `init` 显式生成本机 `native-config.json`，已有文件不会覆盖。
3. 先 `check --probe-native --json`，再正常启动内核，再 `check --probe-mcp --json`。这些步骤不创建原生会话，不调用模型。静态/版本/MCP检查不证明账号和模型权益可用。
4. 用户已在官方程序正常登录时，Codex可通过显式 `--share-codex-login` 复用该用户环境；ZCode使用官方已有登录和供应商配置。不要索要或读取 auth.json、API Key、账户令牌，不复制凭据，不以写入密钥替代登录。
5. 控制聊天通过 MCP 编排，不自动成为受管角色。创建项目、授权范围和真实模型调用必须遵守用户已有授权；不要为了配置检查创建团队或消耗模型额度。
6. 使用同一数据目录正常停止/重启。未知执行保留原 operationId、会话及轮次，查询原操作，不盲目重发、不删锁、不新建替代会话。

先输出真实配置检查结果、仍需用户提供的安装路径/模型偏好及下一步。不要把安装完成、登录复用、真实执行和验收通过混为一谈。
