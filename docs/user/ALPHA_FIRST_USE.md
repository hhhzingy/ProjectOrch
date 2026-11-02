# 首次使用

让其他AI配置时，先给它根目录 [AI_START_HERE.md](../../AI_START_HERE.md) 和 [AI安装与使用手册](AI_INSTALL_AND_USE.md)。整段指令见 [可复制提示词](AI_PROMPTS.md)。Windows ZIP和源码都包含这些文件及 scripts/setup.mjs。

1. 在新目录解压Windows包，核对SHA256SUMS，使用自带runtime/node.exe；源码方式先用Node24安装固定依赖并构建。
2. 用setup discover找入口，init首次生成无密钥native-config.json。已在同一Windows用户正常登录Codex时，显式选择--share-codex-login；ZCode使用官方已有登录及供应商配置，不复制认证。已有配置不覆盖。
3. 运行setup check --probe-native --json。它只查配置和版本命令，账号、模型权益及额度保持未验。
4. 使用同一数据目录正常启动内核，setup check --probe-mcp --json验证本机控制入口；浏览器按本次交互终端配对信息连接，不保存或公开配对代码。
5. setup mcp-config生成当前目录的稳定stdio桥配置，按手册通过官方入口加入日常控制Harness；在该控制聊天实际调用projectorch_identity确认加载。
6. 在Web新建项目并明确选择三角色模板、工作目录、职责、权限和预算，将页面生成指令交给控制聊天。bootstrap后保存operationId，全部ready后才向负责人发送一次目标。控制聊天不自动成为受管负责人。

Codex按当前角色授权独立设只读或工作区可写沙箱，旧项目不自动扩权，详见 [沙箱说明](CODEX_SANDBOX.md)。真实模型测试只按用户已有授权进行；安装检查默认零模型输入。暂停、预算、未知恢复和可信身份检查仍有效。

日常在Web看真实状态、问题、成果与下一步。对话视图展示用户/助手正文，有分页和截断，不是完整原始事件流。unknown保留原会话/轮次、查询原操作，不新建替代团队、不删锁或改库。正常停止/重启保留数据与项目，详见 [运行与恢复](WINDOWS_CANDIDATE_GUIDE.md)。
