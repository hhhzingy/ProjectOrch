# AI 安装与使用手册

适用：Windows 本地 Alpha。目标是让接手 AI 使用明确命令完成接入，不依赖维护者电脑、聊天历史或开发环境。版本/哈希不是 Harness 运行白名单；未测版本可以尝试，实际接口失败如实报告。

## 1. 分清四项配置

| 项目 | 需要什么 | 不代表什么 |
| --- | --- | --- |
| 官方程序 | Codex 的实际 codex.exe；ZCode 的实际 zcode.cjs 及 Node | 找到文件不证明能运行 |
| 官方登录 | 在同一 Windows 用户下正常登录；Codex显式选择 sharedLogin | 桌面登录不证明所有 CLI 模型/供应商可用 |
| ProjectOrch 原生配置 | 数据目录内 native-config.json，只有路径及非秘密运行参数 | 不填写账号密码/API Key，不复制认证文件 |
| MCP 控制入口 | 安装内的 stdio 桥和同一数据目录 | 控制聊天不自动绑定为项目负责人 |

ZCode标准 SPB_Data 路径会由内核发现；自定义数据位置用 `--zcode-data-dir`。BigModel/Z.ai individual-coding-plan 已有接入实现；Start Plan 不能等同此路径。自定义供应商的模型和账户模型分开选择。不要读取或复制 provider_config.json 来寻找密钥；只允许指定其路径供官方程序正常使用。ZCode桌面是否展示受管会话尚未验收，ProjectOrch可按当前绑定读取用户/助手正文，存在分页和截断。

## 2. 安装

Windows ZIP：从官方 [Releases](https://github.com/hhhzingy/ProjectOrch/releases) 下载 Windows x64 包及 SHA256SUMS，在新目录解压，核对哈希；不要覆盖正在运行的安装。使用包内 Node，不需要额外安装开发工具。

源码：使用 Node.js 24系列（最低24.14，锁定测试目标24.22.0），在仓库根运行 `npm ci --ignore-scripts`、`npm run build`。后续命令中的 `$Node` 换成实际 Node；不能把源码中的 scripts 路径与 ZIP 的另一安装目录混用。

Windows PowerShell 准备变量；以下 D 盘路径只是示例，可以换成用户选择的任意绝对本地目录。数据目录与项目文件夹分开，数据目录不要放进公开仓库。

```powershell
$Install = 'D:\Software\ProjectOrch'
$Data = 'D:\ProjectOrchData'
$Node = Join-Path $Install 'runtime\node.exe'   # 源码方式改为实际 Node 路径
$Setup = Join-Path $Install 'scripts\setup.mjs'
$Main = Join-Path $Install 'apps\kernel\dist\main.js'
& $Node $Setup discover --json
```

发现工具只检查有限的标准安装位置，不执行程序、不读取认证、不扫描整盘。没有找到时，从用户提供的安装目录定位；可执行 `discover --zcode-install-dir 'D:\实际ZCode安装目录' --json`。多个候选需根据实际在用安装确认，不能用文件夹排序推断用户正在使用哪版。

## 3. 首次生成原生配置

把下面两项换成发现结果或用户确认的真实文件路径。已在同一 Windows 用户正常登录 Codex 时，`--share-codex-login` 表示用户明确允许复用其正常登录环境；不要传 auth.json。ZCode默认使用当前 Node，可用 `--zcode-node` 单独指定。

```powershell
$CodexExe = 'C:\实际Codex安装目录\codex.exe'
$ZCodeBundle = 'D:\实际ZCode安装目录\resources\glm\zcode.cjs'
& $Node $Setup init --data-dir $Data --codex-executable $CodexExe --share-codex-login --zcode-bundle $ZCodeBundle
```

只使用 Codex 时删去 `--zcode-bundle`；只使用 ZCode 时删去 Codex 两个参数。若用户明确选择 BigModel 账户模型，可在初始化时加 `--zcode-account-provider account:bigmodel-individual-coding-plan`；Z.ai 对应 `account:zai-individual-coding-plan`。不要替用户默认选择账户类型，未选择时省略。自定义 API 供应商应先在官方 ZCode 正常配置，不在这里填密钥或用账户 providerId 冒充。

init 只创建一个无密钥的 native-config.json，不登录、不启动内核、不创建项目/会话。已有文件返回 CONFIG_EXISTS_NOT_OVERWRITTEN，不覆盖。更新时先备份既有非秘密原生配置，经用户授权只修改需要的字段，保留其他设置；不要删除数据目录重置。源码入口使用相同配置。

## 4. 配置检查与含义

```powershell
& $Node $Setup check --data-dir $Data --json
& $Node $Setup check --data-dir $Data --probe-native --json
```

check 仅读取指定的无密钥 native-config.json，检查结构、路径、运行时、构建入口、超时冲突、登录复用选项和供应商类型。供应商配置和认证文件不读取，仅检查所引用路径存在。文件名必须为 native-config.json 或 native-config.example.json；特殊路径可用 `--native 'D:\别处\native-config.json'`。占位路径、链接/多硬链接配置、内嵌认证字段、未知配置字段均拒绝。

`--probe-native` 只执行官方入口的 `--version`，不创建会话、不调用模型，不展示原始 stdout/stderr。它只证明版本命令运行成功，不验证登录或协议；没有测过的版本不因此被阻止。报告中 ACCOUNT_AND_MODEL_ACCESS 始终 NOT_VERIFIED。

退出码：0表示没有发现配置失败（可能有WARN）；2表示配置或探针失败。PASS_CONFIGURATION_ONLY不是“可以稳定完成真实业务”的承诺。不要为消除NOT_VERIFIED自行发送模型输入。

## 5. 启动内核、检查控制连接

先做零模型启动检查：

```powershell
& $Node $Main --data-dir $Data --check
```

随后正常运行，终端保持打开。以下为用户可见交互终端命令；`--pair` 的一次性信息只用于本机浏览器配对，不写报告或截图公开。AI非交互启动时省略 `--pair`；MCP桥不依赖浏览器配对，也不要在重定向日志时强行打印配对代码。能维护子进程IPC的受信AI启动器可用内核现有 `pair`/`shutdown` 消息，配对数据仅在内存传递，不落盘或输出到公共日志。

```powershell
& $Node $Main --data-dir $Data --pair
```

另一个终端中：

```powershell
& $Node $Setup check --data-dir $Data --probe-mcp --json
```

控制探针使用既有桥正常消费 ProjectOrch 本机发现/控制凭据，完成 initialize、tools/list 和 projectorch_identity，只报告成功/失败，不输出令牌、identity正文、项目或对话。零模型输入，不检查 Harness 登录。内核未启动、目录错或入口无效时明确失败。

## 6. 给日常 AI 接入 MCP

推荐稳定 stdio 入口，不手抄端口和令牌。工具只生成片段，不修改官方配置：

```powershell
& $Node $Setup mcp-config --data-dir $Data --format codex
& $Node $Setup mcp-config --data-dir $Data --format zcode-ui
```

Codex 可用官方配置入口合并输出的 `[mcp_servers.projectorch]`，保留其他服务器。也可运行以下官方 CLI 命令，由它维护配置，不让 AI 读取整份可能含秘密的用户配置：

```powershell
& $CodexExe mcp add projectorch -- $Node (Join-Path $Install 'scripts\mcp-control-bridge.mjs') --data-dir $Data
```

已有同名 projectorch 时先检查其来源和数据目录，经用户授权更新该项，不覆盖其他配置。让当前聊天按官方方法重新加载工具；不能把保存配置当作当前聊天已加载。

ZCode桌面：设置→MCP服务器→新建→完整配置，粘贴 `--format zcode-ui` 输出，选择用户或工作区作用域并启用；普通表单则命令填 Node，参数按输出的 args 数组逐项填写。原生文件形状用 `--format zcode` 生成（顶层 mcp.servers），与桌面完整配置输入形状分开。不要将整份配置覆盖到用户已有 `.zcode` 文件。当前聊天不能热加载时按官方流程新开控制聊天；这不会替换项目已有受管角色会话。

官方格式来源：[Codex MCP](https://developers.openai.com/codex/mcp)、[ZCode MCP](https://zcode.z.ai/cn/docs/mcp-services)。CLI/桌面版本可能演进，实际解析失败如实报告，不能手改官方程序绕过。

在真正使用的控制聊天里调用 projectorch_identity，确认 kind 为 control_entry（控制入口主体），并确认工具列表包含项目/消息/操作查询工具。它不等于普通受管角色，也不证明当前聊天的原生身份。setup 的控制探针不能证明“你的这个聊天已加载MCP”，这一步需在该聊天实际调用。

## 7. 创建项目并开始工作

在Web选新建项目，填写用户目标和实际项目目录，选择“三角色协作”，确认职责、项目范围、并发和预算；复制页面生成的真实项目启动指令给控制聊天。控制聊天调用 projectorch_project_bootstrap，保存 operationId，并查询同一操作；所有角色ready后再给负责人发送一次明确目标。字段以当前工具Schema为准，不自行猜 API 参数。

新模板采用显式递归 `**` 权限。每个Codex绑定按当前项目/角色授权配置沙箱，可同时一个只读、一个工作区可写；可写根仅本绑定目录。旧单层 `*` 不是递归授权，旧项目不自动扩权；详细规则见 [Codex沙箱](CODEX_SANDBOX.md)。管理角色不能自行扩大权限、预算或解除用户暂停。

真实模型测试需要用户已明确目标、项目目录、模型/供应商和调用范围。沿用已有授权，不反复询问；信息缺失时只补最少必要信息。默认安装检查不消耗模型。经授权的小测试应保存原生会话/轮次和真实文件，再由独立步骤验证结果；unknown、429、原生失败按约定停止，不自动重试或购买额度，不用 reset credit。

## 8. 日常执行、恢复与排障

- 先查项目、角色、任务与原操作，不靠聊天记忆猜状态。业务任务先read，再对draft/ready认领同一attempt，active后再登记/提问/提交。工具传输成功不等于业务成功。
- 消息使用唯一requestId；超时后查询原记录，不另换键重复发送。unknown保留原会话、轮次和占用，先通过支持的只读核对恢复；不删锁、改SQLite或复制会话历史。
- 正常停止用启动终端Ctrl+C或受信IPC shutdown；正常重启使用同一数据目录。升级到新安装目录前停止旧程序并备份数据；不要用旧程序打开新schema库。
- CODEX_SHARED_LOGIN警告：确认同一Windows用户及显式sharedLogin；登录过期在官方程序处理，不读取认证文件。官方桌面和CLI使用不同环境时，不能把桌面已登录当CLI已就绪。
- 路径/配置失败先运行check；MCP失败核对内核是否运行、安装/数据目录、当前聊天是否加载工具；不要抄旧端口或控制码。
- MODEL_ACCOUNT_CLI_PROVIDER_UNSUPPORTED：供应商路径不支持，不切换模型冒充成功。原生接口报错保留安全错误码，不把私密原始stderr写报告。
- CODEX_SANDBOX_RECURSIVE_GRANT_REQUIRED：由用户明确配置该会话目录的递归授权，不能改成完全可写。
- 不公开上传数据目录、项目私有内容、真实聊天、截图配对码、auth或供应商配置。卸载只移除已确认的安装目录，保留用户项目、数据和官方历史。

## 9. 交付给用户的简短记录

记录安装版本/下载哈希、安装及数据目录、配置检查结果、MCP在实际控制聊天是否调用成功、哪些官方程序版本已观察。将“静态检查通过”“版本命令通过”“控制连接通过”“真实模型调用通过”“业务验收通过”分别列出。未经模型测试就明确写未验；不要收集认证内容，不把本机私有检查报告自动提交公开仓库。
