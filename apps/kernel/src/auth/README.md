# 本地配对（Local Pairing）准备组件

2026-10-19补充：T012已经完成，T007仍未完成，T013保持准备状态。新增 `browser-session.ts` 与迁移003，将一次性挑战消费和浏览器凭据创建置于同一SQLite事务；32随机字节Cookie令牌/CSRF令牌仅返回受信配对调用，库中分用途加盐式摘要（用途+sessionId+令牌），不存原值。凭据固定到期（默认8小时、最多24小时）、可撤销、拒绝创建前/到期后使用；写调用需会话专用CSRF，读与事件观察也必须验证有效会话。Cookie提供HttpOnly/SameSite=Strict/Path=/，HTTPS由可信监听配置开启Secure。

此处仍未启动HTTP服务、浏览器UI或SSE路由。`authenticateBrowserSession`接收经过可信HTTP层提取的单一Cookie值，不替代Host/Origin/重复头检查；mode与本地principalId来自可信路由和启动配置，不得取自请求正文。`revokeBrowserSession`只传刚认证的当前用户身份，不是对任意模型开放的凭据管理API。项目/动作授权、角色MCP身份、原生审批和用户暂停仍未实现。下文是先前配对切片说明，涉及尚无浏览器凭据部分以本补充为准。

这是 T013 的独立准备切片，没有从内核工程入口启动生产服务，也没有实现浏览器 Cookie/CSRF 会话、凭据管理、角色授权或可信 Agent 绑定。T007/T012 前置未满足，T013 仍为 TODO；A020/A021 保持 NOT_RUN。

## 来源检查

`localOrigin` 从受信启动配置和实际监听端口生成唯一允许的 Origin 与 Host，只接受标准形式的 localhost、127.0.0.1 或 ::1。不能从收到的 Host/Forwarded 头反推允许来源。实际服务仍必须只绑定回环地址。

`assertPairingSource(config, peerAddress, rawHeaders)` 用于配对 POST：取真实 socket 地址及 Node HTTP 的原始头数组，精确匹配配置的 Host/Origin/端口，拒绝重复安全头、null Origin、非 JSON 简单表单、非回环连接和头换行。Content-Type 接受 application/json，可带 charset=utf-8。不要用已经合并重复值的请求头映射代替 rawHeaders，不信任代理提供的客户端地址。方法与路由、请求体大小、会话认证及其他 API 的读写来源策略仍由后续服务器实现。

## 挑战存储

`issuePairingChallenge(store, now?, ttlMs?)` 只能由受信本地启动或明确用户操作调用，不开放给未认证网页。32 随机字节生成 43 字符 base64url 代码；短期默认 2 分钟、上限 5 分钟。原始代码只在返回值中交给受信本地 UI 一次，数据库仅保留带用途前缀的 SHA-256 摘要。不得把代码写进 URL、日志、报告、项目配置或长效凭据。

`consumePairingChallenge(db, input, now?)` 必须处于已有同步事务，调用前先验证来源。输入遵循固定 pairing v2 Schema，不接收正文自报身份。不存在、到期、已消费、失败达 5 次或代码不匹配均返回 accepted=false，不暴露具体挑战状态。有效摘要使用定长 timingSafeEqual 比较。错误代码持久增加失败次数；锁定不由 Agent 解开，用户需在受信本地入口取得新挑战。

**失败返回必须正常提交事务以保留计数，然后在事务外返回拒绝响应；不要在事务里因 accepted=false 抛异常而回滚计数。** 接受挑战后，未来浏览器会话的建立必须在同一事务内；会话签发失败时回滚挑战消费，避免半配对。accepted=true 本身不产生可信主体，不代表已建立浏览器会话，更不能据此开放角色工具。

本组件沿用既有 pairing_challenges 表，无新增迁移或第三方依赖。now/ttlMs 是受信内部时钟与策略参数，不来自请求正文。没有实现自动续期、全局网络限流、挑战历史清理或浏览器会话恢复。

## 验证

先 `npm run build`，再使用锁定 Node 24.22.0：

```powershell
node --test tests/security/auth/*.test.mjs
```

`npm run test:security` 先构建再运行该切片；`npm run test:integration` 包含存储与该安全切片，须用锁定 Node。测试仅使用合成输入和新生成的临时测试代码；进程竞争测试通过 IPC 传递代码，不写 argv。真实 HTTP 测试只创建短暂回环来源探针，不产生生产配对响应或 Cookie。临时服务器、数据库与子进程均在测试结束后关闭并清理。
