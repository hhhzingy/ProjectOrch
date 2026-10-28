/** T110（PR2-W1）：MCP 私有 HTTP 常驻入口。
 * - 随内核生命周期启动（kernel-runtime 集成），回环+一次性配对令牌
 * - A128 协议合规（MCP Streamable HTTP 2025-06-18 子集）：POST /mcp JSON-RPC；
 *   通知（无id）受理后返回 202 无正文；Origin 校验（仅回环源）；非 POST 的 /mcp 返回 405；
 *   未知路径 404；重复鉴权头/超大负载 4xx
 * - 安全：日志仅白名单元数据（令牌与请求正文绝不进日志）；撤销的令牌不可再写；
 *   令牌轮换（旧令牌立即失效）；会话寿命上限与容量上限
 * - 两类主体由 backendForConnection 决定（控制入口主体/受管角色主体——上层装配） */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID,createHash } from "node:crypto";
import { McpSession, type McpBackend } from "./mcp-session.js";
import { listenBrowserLoopback } from "../http/browser-listener.js";

export type { McpBackend };

const MAX_BODY = 1024 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export interface McpHttpHostOptions {
  /** 每个新MCP客户端连接调用一次（按Mcp-Session-Id区分）；返回该连接的backend。 */
  readonly backendForConnection: (connectionId: string) => McpBackend;
  readonly onConnectionClose?: (connectionId: string) => void;
  /** 审计日志回调：只收白名单元数据（方法/路径/状态/连接数），不收令牌与正文。 */
  readonly audit?: (info: { readonly method: string; readonly path: string; readonly status: number; readonly connectionCount: number; readonly reason: string; readonly tool?: string }) => void;
  /** 初始令牌（受信启动器生成保存）；缺省时生成新令牌（探针/测试用）。 */
  readonly initialToken?: string;
  /** 受管角色主体路由（T110）：非控制令牌的Bearer凭据在此解析为角色工具面backend；无效返回null（404不泄露）。
   *  凭据为受管角色agent credential——认证由上层完成，本层只路由。 */
  readonly resolveBearer?: (token: string) => McpBackend | null;
  /** 会话寿命（默认12小时）；到期连接拒绝新请求（客户端重新initialize）。 */
  readonly connectionLifetimeMs?: number;
}

export interface McpHttpHost {
  readonly url: string;
  readonly bearerToken: string;
  readonly connections: () => number;
  /** 令牌轮换：旧令牌立即失效（撤销语义），返回新令牌。 */
  rotateToken(): string;
  revokeToken(): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size > MAX_BODY) { resolve(null); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
    request.on('aborted',()=>resolve(null));
    request.on('close',()=>{if(!request.complete)resolve(null);});
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

/** 建立回环MCP HTTP宿主（A128合规子集）。close关闭全部连接与监听。 */
export function startMcpHttpHost(options: McpHttpHostOptions): Promise<McpHttpHost> {
  if (typeof options.backendForConnection !== "function" || options.backendForConnection.constructor.name === "AsyncFunction") return Promise.reject(new Error("SYNC_MCP_BACKEND_REQUIRED"));
  let bearerToken = options.initialToken ?? `projectorch-${randomUUID()}`;
  let revoked = false;
  let closing=false,closePromise:Promise<void>|undefined;
  interface Entry { readonly session: McpSession; readonly createdAt: number;readonly tokenKey:string }
  const connections = new Map<string, Entry>();
  const lifetime = options.connectionLifetimeMs ?? MAX_CONNECTION_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetime) || lifetime < 60_000 || lifetime > 24 * 60 * 60 * 1000) return Promise.reject(new Error("INVALID_CONNECTION_LIFETIME"));
  const audit = (info: { method: string; path: string; status: number; reason: string; tool?: string }) => { try { options.audit?.({ ...info, connectionCount: connections.size }); } catch { /* 审计不影响协议 */ } };
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if(closing){request.destroy();return;}
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        // A128：非 /mcp 路径一律404（不泄露存在性）
        if (pathname !== "/mcp") { audit({ method: request.method ?? "", path: pathname, status: 404, reason: "path" }); writeJson(response, 404, { error: "NOT_FOUND" }); return; }
        // A128：非 POST（GET无SSE支持）返回405 Method Not Allowed
        if (request.method !== "POST") { audit({ method: request.method ?? "", path: pathname, status: 405, reason: "method" }); response.writeHead(405, { allow: "POST", "content-type": "application/json", "content-length": "28", "cache-control": "no-store" }); response.end('{"error":"METHOD_NOT_ALLOWED"}'); return; }
        // DR06：从rawHeaders可靠检测关键头重复（Node规范化会折叠/丢弃重复值，不能靠headers.authorization数组判断）
        const rawCounts = new Map<string, number>();
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i]?.toLowerCase();
          if (name === "authorization" || name === "host" || name === "mcp-session-id" || name === "origin") rawCounts.set(name, (rawCounts.get(name) ?? 0) + 1);
        }
        for (const [name, count] of rawCounts) if (count > 1) { audit({ method: "POST", path: pathname, status: 400, reason: `duplicate-${name}` }); writeJson(response, 400, { error: `DUPLICATE_${name.toUpperCase().replaceAll("-", "_")}_HEADER` }); return; }
        // DR06：Host校验（回环入口约定——Host必须为127.0.0.1[:port]/localhost[:port]/[::1][:port]）
        const host = request.headers.host;
        if (typeof host !== "string" || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host)) { audit({ method: "POST", path: pathname, status: 403, reason: "host" }); writeJson(response, 403, { error: "HOST_REJECTED" }); return; }
        // 鉴权：单一Authorization头；缺失/错误→404（不泄露配对状态）；撤销后同样拒绝
        const authRaw = request.headers.authorization;
        if (authRaw === undefined || !authRaw.startsWith("Bearer ")) { audit({ method: "POST", path: pathname, status: 404, reason: "auth-missing" }); writeJson(response, 404, { error: "NOT_FOUND" }); return; }
        // T110多主体路由：控制令牌→控制backend；其余Bearer→受管角色凭据解析（无效null→404）
        const tokenRaw = authRaw.slice(7);
        const isControlToken = tokenRaw === bearerToken;
        let connectionBackend: McpBackend | null = null;
        if (isControlToken) connectionBackend = options.backendForConnection(randomUUID());
        else if (options.resolveBearer) connectionBackend = options.resolveBearer(tokenRaw);
        if (revoked || !connectionBackend) { audit({ method: "POST", path: pathname, status: 404, reason: "auth-rejected" }); writeJson(response, 404, { error: "NOT_FOUND" }); return; }
        const resolvedBackend = connectionBackend;
        // A128：Origin校验（仅回环源或缺省——官方本地客户端可能不带Origin）
        const origin = request.headers.origin;
        if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(origin)) { audit({ method: "POST", path: pathname, status: 403, reason: "origin" }); writeJson(response, 403, { error: "ORIGIN_REJECTED" }); return; }
        const body = await readBody(request);
        if(closing){request.destroy();return;}
        if (body === null) { audit({ method: "POST", path: pathname, status: 413, reason: "size" }); writeJson(response, 413, { error: "PAYLOAD_TOO_LARGE" }); return; }
        // DR06：业务执行前最终核验（撤销竞态——body读取期间令牌可能被撤销/轮换）。
        // T110多主体：控制令牌按轮换核验；角色凭据不适用host令牌轮换语义——首次已由resolveBearer逐请求认证（撤销即null）。
        if (revoked || (isControlToken && tokenRaw !== bearerToken)) { audit({ method: "POST", path: pathname, status: 404, reason: "auth-revoked-midflight" }); writeJson(response, 404, { error: "NOT_FOUND" }); return; }
        // 连接管理：Mcp-Session-Id复用或新建（寿命/容量上限）
        const sidRaw = request.headers["mcp-session-id"];
        if (Array.isArray(sidRaw) && sidRaw.length > 1) { audit({ method: "POST", path: pathname, status: 400, reason: "session-duplicate" }); writeJson(response, 400, { error: "DUPLICATE_SESSION_HEADER" }); return; }
        const sid = (Array.isArray(sidRaw) ? sidRaw[0] : sidRaw) ?? undefined;
        let entry = typeof sid === "string" ? connections.get(sid) : undefined;
        const tokenKey=createHash('sha256').update(tokenRaw).digest('hex');
        if(entry&&entry.tokenKey!==tokenKey){audit({method:'POST',path:pathname,status:404,reason:'session-auth-mismatch'});writeJson(response,404,{error:'CONNECTION_NOT_FOUND'});return;}
        if (entry && Date.now() - entry.createdAt > lifetime) { if (sid !== undefined) { connections.delete(sid); options.onConnectionClose?.(sid); } entry = undefined; audit({ method: "POST", path: pathname, status: 440, reason: "session-expired" }); }
        if (!entry) {
          if (typeof sid === "string") { audit({ method: "POST", path: pathname, status: 404, reason: "session-unknown" }); writeJson(response, 404, { error: "CONNECTION_NOT_FOUND" }); return; }
          if (connections.size >= MAX_CONNECTIONS) { audit({ method: "POST", path: pathname, status: 503, reason: "capacity" }); writeJson(response, 503, { error: "TOO_MANY_CONNECTIONS" }); return; }
          const connectionId = randomUUID();
          entry = { session: new McpSession(resolvedBackend, (tool, ok) => { audit({ method: "POST", path: pathname, status: ok ? 200 : 400, reason: "tools/call", tool }); }), createdAt: Date.now(),tokenKey };
          connections.set(connectionId, entry);
          response.setHeader("Mcp-Session-Id", connectionId);
        } else if (typeof sid === "string") response.setHeader("Mcp-Session-Id", sid);
        // DR06：非法JSON收敛为受控错误（不使进程退出）
        const replies: unknown[] = [];
        let sawNotification = false;
        for (const frame of body.split("\n")) {
          if (!frame.trim()) continue;
          let reply: ReturnType<McpSession["receive"]>;
          try { reply = entry.session.receive(JSON.parse(frame)); }
          catch { audit({ method: "POST", path: pathname, status: 400, reason: "malformed-json" }); writeJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
          if (reply) replies.push(reply); else sawNotification = true;
          if (entry.session.closed) break;
        }
        if (entry.session.closed) {
          for (const [id, e] of connections) if (e === entry) { connections.delete(id); options.onConnectionClose?.(id); }
          audit({ method: "POST", path: pathname, status: 200, reason: "session-closed-by-backend" });
        } else audit({ method: "POST", path: pathname, status: 200, reason: "ok" });
        // A128：纯通知批次（无任何响应）返回202无正文（2025-06-18规范）
        if (replies.length === 0 && sawNotification) { response.writeHead(202, { "cache-control": "no-store" }); response.end(); return; }
        writeJson(response, 200, replies.length === 1 ? replies[0] : replies);
      } catch (error) {
        // DR06：全路径异常收敛——服务继续运行，不泄露正文
        audit({ method: request.method ?? "", path: request.url ?? "", status: 500, reason: "internal:" + String((error as Error)?.message ?? "").slice(0, 60) });
        try { writeJson(response, 500, { error: "INTERNAL_ERROR" }); } catch { /* 已销毁 */ }
      }
    })();
  });
  return listenBrowserLoopback(server).then(port => Object.freeze({
        url: `http://127.0.0.1:${port}/mcp`,
        get bearerToken() { return bearerToken; },
        connections: () => connections.size,
        rotateToken(): string { bearerToken = `projectorch-${randomUUID()}`; revoked = false; audit({ method: "-", path: "-", status: 0, reason: "token-rotated" }); return bearerToken; },
        revokeToken(): void { revoked = true; audit({ method: "-", path: "-", status: 0, reason: "token-revoked" }); },
        close: () => {
          if(closePromise)return closePromise;closing=true;
          let resolveClose:()=>void=()=>{},rejectClose:(error:Error)=>void=()=>{};closePromise=new Promise<void>((resolve,reject)=>{resolveClose=resolve;rejectClose=reject;});
          for (const [id,e] of connections){try{e.session.close();}catch{/* 单连接回调失败不阻止关闭监听。 */}try{options.onConnectionClose?.(id);}catch{/* 继续收尾。 */}}
          connections.clear();server.close(error=>error?rejectClose(error):resolveClose());server.closeAllConnections();return closePromise;
        },
      }));
}
