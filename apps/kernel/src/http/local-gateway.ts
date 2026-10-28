/** T013准备切片：本地HTTP防护层。仅回环监听；全部路由执行单一Host/Origin头精确匹配与重复安全头拒绝；配对走rawHeaders来源核验；读写/事件路由走会话凭据（写另需CSRF）。业务对象路由随T014+接入，本层只建立传输与认证边界。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Store } from "@projectorch/persistence";
import { authenticateBrowserSession, browserSessionCookie, completeBrowserPairing, revokeBrowserSession, rotateBrowserCsrf } from "../auth/browser-session.js";
import { assertPairingSource, localOrigin, type LocalOrigin } from "../auth/local-source.js";
import { StaticFileSource } from "./static-files.js";
import { openEventStream, parseEventCursor } from "./event-stream.js";
import { conversationPage } from "@projectorch/domain/conversation";
import { listProjects } from "@projectorch/domain/projects";
import { listRolesWithStates, roleHistory, readRoleModelPreference } from "@projectorch/domain/roles";
import { hostname } from "node:os";
import {createHash,randomUUID} from 'node:crypto';
import type {SessionRef} from '@projectorch/adapter-contract';
import type {VisibleConversation} from '../native/conversation-reader.js';
import {configureRoleModelPreference} from "../commands/role-model-preference.js";
import {roleSupervisionState} from './role-supervision.js';
import {questionContract} from '../tools/question-workflow.js';
import { createProjectForUser } from "../commands/project-create.js";
import { applyChangesetForUser, readUserPolicy } from "../commands/user-changesets.js";
import { readTaskDetail, taskDetailPage, readTaskReview, readTaskReadiness } from "./task-queries.js";
import { parseContract } from "@projectorch/contracts";
import { readArtifactRecord } from "@projectorch/domain/artifacts";
import { readArtifactChunk } from "@projectorch/domain/artifacts/content";
import { listenBrowserLoopback } from "./browser-listener.js";
import {trustedCheckEntries} from '../checks/registry.js';

export const gatewayBodyLimit = 8192;
export const changesetBodyLimit = 1024 * 1024;
const cookieName = "projectorch_session";
const csrfHeader = "x-projectorch-csrf";

export interface LocalGatewayOptions {
  readonly readConversation?:(session:SessionRef,assertCurrent:()=>void)=>Promise<VisibleConversation>;
  readonly store: Store;
  /** 由受信启动器在实际监听端口确定后形成；不得取自请求。 */
  readonly origin: string;
  /** 受信本地用户标识，来自启动器，不得取自请求正文。 */
  readonly principalId: string;
  readonly now?: () => number;
  /** 受信内核在每次访问、异步请求体之后及事件发送前重验；丢锁/关闭时拒绝服务。 */
  readonly assertKernelOwner?: () => void;
  readonly secure?: boolean;
  /** T017准备：命令执行入口。主体来自会话认证，不取自正文；未注入时写路由返回未实现。 */
  readonly commandRunner?: (principalId: string, input: unknown) => unknown;
  /** T017准备：命令错误到HTTP状态的映射。 */
  readonly commandErrorStatus?: (message: string) => 400 | 401 | 403 | 409;
  /** T043准备：本地静态资源目录（配对登录面）。未注入则静态路径404。 */
  readonly webDistDir?: string;
}

export interface StartedGateway {
  readonly server: Server;
  readonly origin: LocalOrigin;
  readonly port: number;
  close(): Promise<void>;
}

interface HeaderView {
  readonly host: readonly string[];
  readonly origin: readonly string[];
  readonly cookie: readonly string[];
  readonly csrf: readonly string[];
  readonly contentType: readonly string[];
  readonly fetchSite: readonly string[];
  readonly fetchMode: readonly string[];
}

function headerView(rawHeaders: readonly string[]): HeaderView {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.length > 256) throw new GatewayError(400, "MALFORMED_HEADERS");
  const view: Record<string, string[]> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]; const value = rawHeaders[i + 1];
    if (typeof name !== "string" || typeof value !== "string" || /[\r\n\0]/.test(name + value)) throw new GatewayError(400, "MALFORMED_HEADERS");
    const key = name.toLowerCase();
    const existing = view[key];
    if (existing) existing.push(value);
    else view[key] = [value];
  }
  return Object.freeze({ host: view.host ?? [], origin: view.origin ?? [], cookie: view.cookie ?? [], csrf: view[csrfHeader] ?? [], contentType: view["content-type"] ?? [], fetchSite: view["sec-fetch-site"] ?? [], fetchMode: view["sec-fetch-mode"] ?? [] });
}

export class GatewayError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 413 | 503, readonly code: string) { super(code); this.name = "GatewayError"; }
}

/** 所有已配对路由的通用来源核验：Host与Origin各出现一次且精确匹配；Cookie与CSRF头不得重复。 */
function assertCommonSource(config: LocalOrigin, headers: HeaderView, readOnly = false): void {
  const [host] = headers.host;
  const [origin] = headers.origin;
  if (headers.host.length !== 1 || host !== config.authority) throw new GatewayError(403, "ORIGIN_REJECTED");
  // 浏览器同源GET通常不带Origin。仅只读路由接受精确Fetch Metadata；写仍必须Origin+CSRF。
  const sameOriginRead = readOnly && headers.origin.length === 0 && headers.fetchSite.length === 1 && headers.fetchSite[0] === "same-origin" && headers.fetchMode.length === 1 && ["cors", "same-origin"].includes(headers.fetchMode[0] ?? "");
  if (!sameOriginRead && (headers.origin.length !== 1 || origin !== config.origin)) throw new GatewayError(403, "ORIGIN_REJECTED");
  if (headers.cookie.length > 1 || headers.csrf.length > 1) throw new GatewayError(400, "DUPLICATE_CREDENTIAL_HEADERS");
}

function sessionCookieValue(headers: HeaderView): string | null {
  const [cookieHeader] = headers.cookie;
  if (headers.cookie.length !== 1 || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === cookieName) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function readBody(request: IncomingMessage, limit = gatewayBodyLimit): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; let chunks: Buffer[] = []; let overflow = false;
    request.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) { overflow = true; chunks = []; reject(new GatewayError(413, "BODY_TOO_LARGE")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!overflow) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", () => { if (!overflow) reject(new GatewayError(400, "BODY_READ_FAILED")); });
  });
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

/** 建立本地网关：回环临时端口监听，实际端口确定后形成受信来源；请求只会在监听回调之后到达。 */
export async function startLocalGateway(options: Omit<LocalGatewayOptions, "origin">): Promise<StartedGateway> {
  let config: LocalOrigin | undefined;
  let staticSource: StaticFileSource | undefined;
  try { if (options.webDistDir !== undefined) staticSource = new StaticFileSource(options.webDistDir); } catch { staticSource = undefined; }
  const now = options.now ?? Date.now;
  let closing = false;
  let closePromise:Promise<void>|undefined;
  const conversations=new Map<string,{bindingKey:string;expiresAt:number;value:VisibleConversation}>();
  const conversationReads=new Set<string>();
  const assertAvailable = (): void => {
    if (closing) throw new GatewayError(503, "KERNEL_STOPPING");
    try { options.assertKernelOwner?.(); }
    catch { throw new GatewayError(503, "KERNEL_NOT_OWNER"); }
  };
  const authenticate: typeof authenticateBrowserSession = (...args) => { assertAvailable(); return authenticateBrowserSession(...args); };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        assertAvailable();
        if (!config) throw new GatewayError(403, "GATEWAY_NOT_READY");
        const url = new URL(request.url ?? "/", config.origin);
        const headers = headerView(request.rawHeaders);
        // T043准备：静态登录面（GET/HEAD、非API路径、未认证可达；Host精确匹配，GET无需Origin——写保护由CSRF承担）
        if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/") && options.webDistDir !== undefined && staticSource !== undefined) {
          const [host] = headers.host;
          if (headers.host.length !== 1 || host !== config.authority) throw new GatewayError(403, "ORIGIN_REJECTED");
          const file = staticSource.open(url.pathname);
          response.writeHead(200, { "content-type": file.contentType, "content-length": file.byteSize, "cache-control": "no-store" });
          if (request.method === "HEAD") { file.stream.destroy(); response.end(); return; }
          file.stream.pipe(response);
          file.stream.once("error", () => { if (!response.writableEnded) response.destroy(); });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/pairing") {
          assertPairingSource(config, request.socket.remoteAddress, request.rawHeaders);
          const body = await readBody(request);
          assertAvailable();
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { throw new GatewayError(400, "INVALID_JSON_BODY"); }
          const result = completeBrowserPairing(options.store, parsed, options.principalId, { config, peerAddress: request.socket.remoteAddress, rawHeaders: request.rawHeaders }, now());
          if (!result.accepted) { sendJson(response, 403, { error: "PAIRING_REJECTED" }); return; }
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": browserSessionCookie(result.credentials, options.secure === true) });
          response.end(JSON.stringify({ csrfToken: result.credentials.csrfToken, expiresAt: result.credentials.expiresAt }));
          return;
        }
        if (url.pathname === "/api/v1/pairing") throw new GatewayError(405, "METHOD_NOT_ALLOWED");
        const mode = request.method === "GET" || request.method === "HEAD" ? "read" : "write";
        assertCommonSource(config, headers, mode === "read");
        const csrfRefresh = url.pathname === "/api/v1/session/csrf" && request.method === "POST";
        const principal = authenticate(options.store, sessionCookieValue(headers), headers.csrf[0] ?? null, csrfRefresh ? "read" : url.pathname === "/api/v1/events" ? "events" : mode, now());
        if (csrfRefresh) {
          if (headers.contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.contentType[0] ?? "")) throw new GatewayError(400, "JSON_CONTENT_TYPE_REQUIRED");
          const body = await readBody(request);
          if (body.trim() !== "{}") throw new GatewayError(400, "INVALID_CSRF_REFRESH_BODY");
          authenticate(options.store, sessionCookieValue(headers), null, "read", now());
          sendJson(response, 200, { csrfToken: rotateBrowserCsrf(options.store, principal, now()) });
          return;
        }
        if (url.pathname === "/api/v1/session" && (request.method === "GET" || request.method === "HEAD")) { sendJson(response, 200, { principalId: principal.principalId, hostId: hostname() }); return; }
        if (url.pathname === "/api/v1/session" && request.method === "DELETE") { revokeBrowserSession(options.store, principal, now()); sendJson(response, 200, { revoked: true }); return; }
        if (url.pathname === "/api/v1/changesets" && request.method === "POST") {
          if (headers.contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.contentType[0] ?? "")) throw new GatewayError(400, "JSON_CONTENT_TYPE_REQUIRED");
          let input: unknown;
          try { input = JSON.parse(await readBody(request, changesetBodyLimit)); } catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(400, "INVALID_JSON_BODY"); }
          authenticate(options.store, sessionCookieValue(headers), headers.csrf[0] ?? null, "write", now());
          try { sendJson(response, 202, applyChangesetForUser(options.store, principal.principalId, input, now()) as unknown as Record<string, unknown>); }
          catch (error) {
            const message = String((error as Error)?.message ?? "CHANGESET_REJECTED");
            const status = /NOT_FOUND/.test(message) ? 404 : /CONFLICT|REQUIRES_REPAIR/.test(message) ? 409 : /CAPABILITY_UNSUPPORTED/.test(message) ? 501 : /FORBIDDEN|OUT_OF_SCOPE/.test(message) ? 403 : 422;
            const code = status === 404 ? "NOT_FOUND" : status === 409 ? "REVISION_CONFLICT" : status === 501 ? "CAPABILITY_UNSUPPORTED" : status === 403 ? "FORBIDDEN" : "VALIDATION_ERROR";
            sendJson(response, status, { error: { code, message: message.slice(0, 512), requestId: typeof input === "object" && input !== null && "requestId" in input && typeof input.requestId === "string" ? input.requestId.slice(0, 128) || "invalid" : "invalid", retryable: false } });
          }
          return;
        }
        if (url.pathname === "/api/v1/roles/model-preference" && request.method === "POST") {
          if (headers.contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.contentType[0] ?? "")) throw new GatewayError(400, "JSON_CONTENT_TYPE_REQUIRED");
          let input: Record<string, unknown>;
          try { input = JSON.parse(await readBody(request, changesetBodyLimit)) as Record<string, unknown>; } catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(400, "INVALID_JSON_BODY"); }
          authenticate(options.store, sessionCookieValue(headers), headers.csrf[0] ?? null, "write", now());
          try {
            const saved=configureRoleModelPreference(options.store,principal.principalId,input,now(),()=>{
              const current=authenticate(options.store,sessionCookieValue(headers),headers.csrf[0]??null,'write',now());
              if(current.principalId!==principal.principalId)throw new Error('UNAUTHENTICATED');
            });
            sendJson(response,200,saved);

          } catch (error) {
            if(error instanceof GatewayError)throw error;
            const message=String((error as Error)?.message??'MODEL_PREFERENCE_REJECTED');
            if(/UNAUTHENTICATED|CSRF/.test(message))throw error;
            const status=/NOT_FOUND/.test(message)?404:/CONFLICT/.test(message)?409:400;
            sendJson(response,status,{error:{code:status===404?'NOT_FOUND':status===409?'REVISION_CONFLICT':'VALIDATION_ERROR',message:message.slice(0,256),retryable:false}});
          }

          return;
        }
        if(url.pathname==='/api/v1/check-entries'&&request.method==='GET'){
          if(url.searchParams.size)throw new GatewayError(400,'INVALID_QUERY');sendJson(response,200,{entries:trustedCheckEntries()});return;
        }
        const checkDefinitionMatch=/^\/api\/v1\/checks\/([^/]+)$/.exec(url.pathname);
        if(checkDefinitionMatch&&request.method==='GET'){
          if([...url.searchParams.keys()].some(k=>!['version','projectId'].includes(k))||url.searchParams.getAll('version').length!==1||url.searchParams.getAll('projectId').length!==1)throw new GatewayError(400,'INVALID_QUERY');
          const checkId=decodeURIComponent(checkDefinitionMatch[1]??''),projectId=url.searchParams.get('projectId')??'',version=url.searchParams.get('version')??'',row=options.store.db.prepare('SELECT definition_json,enabled FROM check_definitions WHERE project_id=? AND id=? AND version=?').get(projectId,checkId,version);if(!row)throw new GatewayError(404,'NOT_FOUND');
          const definition=JSON.parse(String(row.definition_json));if(definition.id!==checkId||definition.version!==version){sendJson(response,409,{error:'CHECK_LEGACY_REQUIRES_REPAIR'});return;}const validated=parseContract('command',{schemaVersion:2,requestId:'read-check',projectId,type:'check.register',payload:{definition:{...definition,enabled:row.enabled===1}}});if(validated.type!=='check.register'){sendJson(response,409,{error:'CHECK_LEGACY_REQUIRES_REPAIR'});return;}sendJson(response,200,{...validated.payload.definition});return;
        }
        const receiptMatch = /^\/api\/v1\/commands\/([^/]+)\/receipt$/.exec(url.pathname);
        const requestReceiptMatch = /^\/api\/v1\/receipts\/([^/]+)$/.exec(url.pathname);
        if ((receiptMatch || requestReceiptMatch) && (request.method === "GET" || request.method === "HEAD")) {
          const id = decodeURIComponent((receiptMatch ?? requestReceiptMatch)?.[1] ?? "");
          const row = receiptMatch ? options.store.db.prepare("SELECT receipt_json FROM commands WHERE id=? AND source_principal_id=?").get(id, principal.principalId) : options.store.db.prepare("SELECT receipt_json FROM commands WHERE request_id=? AND source_principal_id=?").get(id, principal.principalId);
          if (!row || row.receipt_json === null) throw new GatewayError(404, "NOT_FOUND");
          sendJson(response, 200, parseContract("receipt", JSON.parse(String(row.receipt_json))) as unknown as Record<string, unknown>);
          return;
        }
        const policyMatch = /^\/api\/v1\/projects\/([^/]+)\/policy$/.exec(url.pathname);
        const contentMatch = /^\/api\/v1\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
        if (contentMatch && (request.method === "GET" || request.method === "HEAD")) {
          try {
            if ([...url.searchParams.keys()].some(key => !["version", "offset"].includes(key)) || url.searchParams.getAll("version").length !== 1 || url.searchParams.getAll("offset").length !== 1 || !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("offset") ?? "")) throw new Error("INVALID_ARTIFACT_QUERY");
            const value = options.store.transaction(() => {
              const query = parseContract("query", { schemaVersion: 2, type: "artifact.content", payload: { artifactId: decodeURIComponent(contentMatch[1] ?? ""), version: url.searchParams.get("version"), offset: Number(url.searchParams.get("offset")) } });
              if (query.type !== "artifact.content") throw new Error("INVALID_ARTIFACT_QUERY");
              const artifact = readArtifactRecord(options.store, String(options.store.db.prepare("SELECT project_id FROM artifacts WHERE id=?").get(query.payload.artifactId)?.project_id ?? ""), query.payload.artifactId);
              return readArtifactChunk(options.store, artifact.projectId, artifact.id, query.payload.version, query.payload.offset, () => {});
            });
            sendJson(response, 200, value as unknown as Record<string, unknown>);
          } catch (error) {
            const message = String((error as Error)?.message ?? "ARTIFACT_NOT_FOUND");
            const status = message === "ARTIFACT_NOT_FOUND" ? 404 : message === "CAPABILITY_UNSUPPORTED" ? 501 : /CONTENT_CHANGED|VERSION_CONFLICT|READ_LIMIT|HASH_REQUIRED/.test(message) ? 409 : 400;
            sendJson(response, status, { error: { code: status === 404 ? "NOT_FOUND" : status === 501 ? "CAPABILITY_UNSUPPORTED" : status === 409 ? "INVALID_STATE" : "VALIDATION_ERROR", message: message.slice(0, 128), requestId: "read", retryable: false } });
          }
          return;
        }
        const tasksMatch = /^\/api\/v1\/projects\/([^/]+)\/tasks$/.exec(url.pathname);
        const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
        const reviewMatch = /^\/api\/v1\/tasks\/([^/]+)\/review$/.exec(url.pathname);
        const readinessMatch = /^\/api\/v1\/tasks\/([^/]+)\/readiness$/.exec(url.pathname);
        if ((policyMatch || tasksMatch || taskMatch || reviewMatch || readinessMatch) && (request.method === "GET" || request.method === "HEAD")) {
          try {
            if (readinessMatch && url.searchParams.size > 0) { sendJson(response, 400, { error: { code: "VALIDATION_ERROR", message: "INVALID_QUERY", requestId: "read", retryable: false } }); return; }
            const value = options.store.transaction(db => {
              if (readinessMatch) return readTaskReadiness(options.store, decodeURIComponent(readinessMatch[1] ?? ""));
              if (policyMatch) return readUserPolicy(db, decodeURIComponent(policyMatch[1] ?? ""));
              if (reviewMatch) return readTaskReview(db, decodeURIComponent(reviewMatch[1] ?? ""));
              if (tasksMatch) return taskDetailPage(db, decodeURIComponent(tasksMatch[1] ?? ""), url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50, url.searchParams.get("cursor"));
              return readTaskDetail(db, decodeURIComponent(taskMatch?.[1] ?? ""));
            });
            sendJson(response, 200, value as unknown as Record<string, unknown>);
          } catch (error) {
            const message = String((error as Error)?.message ?? "QUERY_REJECTED");
            sendJson(response, /NOT_FOUND/.test(message) ? 404 : 409, { error: { code: /NOT_FOUND/.test(message) ? "NOT_FOUND" : "INVALID_STATE", message: message.slice(0, 128), requestId: "read", retryable: false } });
          }
          return;
        }
        // T043：Web导航只读端点（会话鉴权；期望/观测状态并列；停用角色保留在列）
        if (url.pathname === "/api/v1/projects" && (request.method === "GET" || request.method === "HEAD")) {
          sendJson(response, 200, { projects: listProjects(options.store) });
          return;
        }
        if (url.pathname === "/api/v1/projects" && request.method === "POST") {
          if (headers.contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.contentType[0] ?? "")) throw new GatewayError(400, "JSON_CONTENT_TYPE_REQUIRED");
          let input: unknown;
          try { input = JSON.parse(await readBody(request)); } catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(400, "INVALID_JSON_BODY"); }
          authenticate(options.store, sessionCookieValue(headers), headers.csrf[0] ?? null, "write", now());
          try { sendJson(response, 200, createProjectForUser(options.store, principal.principalId, hostname(), input, now())); }
          catch (error) { const message = String((error as Error)?.message ?? "PROJECT_CREATE_REJECTED"); sendJson(response, /IDEMPOTENCY_CONFLICT|PROJECT_ROOT_OCCUPIED/.test(message) ? 409 : 400, { error: message.slice(0, 128) }); }
          return;
        }
        const rolesMatch = /^\/api\/v1\/projects\/([^/]+)\/roles$/.exec(url.pathname);
        const questionListMatch=/^\/api\/v1\/projects\/([^/]+)\/questions$/.exec(url.pathname);
        if(questionListMatch&&(request.method==='GET'||request.method==='HEAD')){
          if([...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length>1)throw new GatewayError(400,'INVALID_QUERY');
          const projectId=decodeURIComponent(questionListMatch[1]??'');if(!options.store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw new GatewayError(404,'NOT_FOUND');
          const rows=options.store.db.prepare("SELECT id,revision,deadline,ask_command_id FROM questions WHERE project_id=? AND answerer_kind='user' AND state='open' ORDER BY deadline,id").all(projectId);
          const signature=createHash('sha256').update(JSON.stringify([projectId,rows])).digest('hex');let offset=0;
          const cursor=url.searchParams.get('cursor');if(cursor){try{if(cursor.length>2048)throw Error();const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(parsed.signature!==signature||!Number.isSafeInteger(parsed.offset)||parsed.offset<0||parsed.offset>rows.length)throw Error();offset=parsed.offset;}catch{sendJson(response,409,{error:'PAGE_CURSOR_STALE'});return;}}
          const compatible=rows.filter(q=>q.ask_command_id!==null),selected=compatible.slice(offset,offset+50);
          sendJson(response,200,{projectId,items:selected.map(q=>questionContract(options.store.db,projectId,String(q.id))),legacyCount:rows.length-compatible.length,nextCursor:offset+selected.length<compatible.length?Buffer.from(JSON.stringify({signature,offset:offset+selected.length})).toString('base64url'):null});return;
        }
        const questionMatch=/^\/api\/v1\/questions\/([^/]+)$/.exec(url.pathname);
        if(questionMatch&&(request.method==='GET'||request.method==='HEAD')){
          if(url.search)throw new GatewayError(400,'INVALID_QUERY');
          const questionId=decodeURIComponent(questionMatch[1]??''),row=options.store.db.prepare('SELECT project_id FROM questions WHERE id=?').get(questionId);
          if(!row)throw new GatewayError(404,'NOT_FOUND');
          try{sendJson(response,200,{...questionContract(options.store.db,String(row.project_id),questionId)});}catch{sendJson(response,409,{error:'QUESTION_LEGACY_REQUIRES_REPAIR'});}return;
        }
        if (rolesMatch && (request.method === "GET" || request.method === "HEAD")) {
          const projectId = decodeURIComponent(rolesMatch[1] ?? '');
          if (!options.store.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new GatewayError(404, "NOT_FOUND");
          sendJson(response, 200, { projectId, roles: listRolesWithStates(options.store, projectId) });
          return;
        }
        const conversationMatch=/^\/api\/v1\/projects\/([^/]+)\/roles\/([^/]+)\/conversation$/.exec(url.pathname);
        if(conversationMatch&&request.method==='GET'){
          const projectId=decodeURIComponent(conversationMatch[1]??''),roleId=decodeURIComponent(conversationMatch[2]??'');
          const bound=()=>options.store.db.prepare('SELECT b.id,b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL').get(projectId,roleId);
          if(!options.store.db.prepare('SELECT 1 FROM roles WHERE id=? AND project_id=?').get(roleId,projectId))throw new GatewayError(404,'NOT_FOUND');
          const binding=bound();if(!binding){sendJson(response,200,{status:'unbound',items:[],nextCursor:null,limited:false});return;}
          const bindingKey=JSON.stringify(binding),cursor=url.searchParams.get('cursor');let snapshot:string,offset:number,value:VisibleConversation;
          const assertCurrent=()=>{authenticate(options.store,sessionCookieValue(headers),null,'read',now());if(JSON.stringify(bound())!==bindingKey)throw new GatewayError(503,'CONVERSATION_BINDING_CHANGED');};
          if(cursor){
            const match=/^([a-f0-9-]{36}):(\d{1,4})$/.exec(cursor);if(!match)throw new GatewayError(400,'INVALID_CURSOR');
            snapshot=match[1] as string;offset=Number(match[2]);const cached=conversations.get(snapshot);
            if(!cached||cached.expiresAt<=now()||cached.bindingKey!==bindingKey)throw new GatewayError(503,'CONVERSATION_REFRESH_REQUIRED');
            value=cached.value;
          }else{
            if(!options.readConversation)throw new GatewayError(503,'CONVERSATION_READER_NOT_CONFIGURED');
            if(conversationReads.has(bindingKey)||conversationReads.size>=3)throw new GatewayError(503,'CONVERSATION_READ_BUSY');
            conversationReads.add(bindingKey);
            try{
              const session:SessionRef={harnessId:String(binding.harness_id),hostId:String(binding.host_id),profileId:String(binding.profile_id),nativeConversationId:String(binding.native_conversation_id),...(binding.native_workspace_id?{nativeWorkspaceId:String(binding.native_workspace_id)}:{})};
              value=await options.readConversation(session,assertCurrent);assertCurrent();
            }catch(error){if(error instanceof GatewayError)throw error;throw new GatewayError(503,'CONVERSATION_READ_UNAVAILABLE');}
            finally{conversationReads.delete(bindingKey);}
            snapshot=randomUUID();offset=0;
            for(const [key,entry]of conversations)if(entry.expiresAt<=now())conversations.delete(key);
            while(conversations.size>=10){const first=conversations.keys().next().value;if(first)conversations.delete(first);}
            conversations.set(snapshot,{bindingKey,expiresAt:now()+300000,value});
          }
          assertCurrent();const items=value.items.slice(offset,offset+30),next=offset+items.length;
          sendJson(response,200,{status:'observed',bindingId:binding.id,bindingEpoch:binding.epoch,harnessId:binding.harness_id,source:'official-history',items,nextCursor:next<value.items.length?`${snapshot}:${next}`:null,limited:value.limited});return;
        }
        const historyMatch = /^\/api\/v1\/projects\/([^/]+)\/roles\/([^/]+)\/history$/.exec(url.pathname);
        if (historyMatch && (request.method === "GET" || request.method === "HEAD")) {
          const projectId = decodeURIComponent(historyMatch[1] ?? '');
          const roleId = decodeURIComponent(historyMatch[2] ?? '');
          if (!options.store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new GatewayError(404, "NOT_FOUND");
          sendJson(response, 200, { projectId, roleId, history: roleHistory(options.store, projectId, roleId) });
          return;
        }
        // T120（PR2-W4）：项目运行总览（监督视图）——角色/harness/请求与实际模型/推理/当前任务/等待原因/下一动作
        if (url.pathname === "/api/v1/overview" && (request.method === "GET" || request.method === "HEAD")) {
          const projects = listProjects(options.store).map(project => {
            const roles = listRolesWithStates(options.store, project.projectId).map(role => {
              const prefRow = options.store.db.prepare("SELECT model_requested_json, model_resolved_json, model_effective_json FROM roles WHERE id=? AND project_id=?").get(role.roleId, project.projectId) as { model_requested_json: string | null; model_resolved_json: string | null; model_effective_json: string | null } | undefined;
              const harnessRow = options.store.db.prepare("SELECT s.harness_id AS harnessId FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL LIMIT 1").get(project.projectId, role.roleId) as { harnessId: string } | undefined;
              const supervision=roleSupervisionState(options.store,project.projectId,role.roleId);
              return { ...role, harnessId: harnessRow?.harnessId ?? null, modelRequested: prefRow?.model_requested_json === null || prefRow?.model_requested_json === undefined ? null : JSON.parse(String(prefRow.model_requested_json)), modelResolved: prefRow?.model_resolved_json === null || prefRow?.model_resolved_json === undefined ? null : JSON.parse(String(prefRow.model_resolved_json)), modelEffective: prefRow?.model_effective_json === null || prefRow?.model_effective_json === undefined ? null : JSON.parse(String(prefRow.model_effective_json)), modelEffectiveStatus: prefRow?.model_effective_json ? "observed" : "pending-session", ...supervision };
            });
            const pendingWorkflow = Number(options.store.db.prepare("SELECT COUNT(*) AS n FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.project_id=? AND o.state='pending' AND json_extract(o.payload_json,'$.event')='workflow.evaluate'").get(project.projectId)?.n);
            const unknownAttempts = Number(options.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state='unknown'").get(project.projectId)?.n);
            const activeAttempts = Number(options.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state IN ('dispatching','running','waiting_input')").get(project.projectId)?.n);
            return { ...project, roles, runState: project.userPaused ? "paused" : unknownAttempts > 0 ? "unknown-execution" : activeAttempts > 0 ? "executing" : pendingWorkflow > 0 ? "ready-to-dispatch" : "idle", pendingWorkflow, unknownAttempts, activeAttempts };
          });
          sendJson(response, 200, { projects, generatedAt: now() });
          return;
        }
        // T121（PR2-W4）：角色模型偏好读取
        const prefMatch = /^\/api\/v1\/projects\/([^/]+)\/roles\/([^/]+)\/model-preference$/.exec(url.pathname);
        if (prefMatch && (request.method === "GET" || request.method === "HEAD")) {
          const projectId = decodeURIComponent(prefMatch[1] ?? '');
          const roleId = decodeURIComponent(prefMatch[2] ?? '');
          if (!options.store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new GatewayError(404, "NOT_FOUND");
          const pref = readRoleModelPreference(options.store, projectId, roleId);
          sendJson(response, 200, { projectId, roleId, revision:pref.revision,modelRevision:pref.modelRevision,requested: pref.requested, resolved: pref.resolved });
          return;
        }
        // T044准备：对话面板端点（会话鉴权+分页+gap检测——读模型来自T022投影/T044视图）
        if (url.pathname === "/api/v1/conversation" && request.method === "GET") {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) throw new GatewayError(400, "SESSION_ID_REQUIRED");
          if (!options.store.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new GatewayError(404, "NOT_FOUND");
          const cursorOccurredAt = Number(url.searchParams.get("cursorOccurredAt") ?? 0);
          if (!Number.isSafeInteger(cursorOccurredAt) || cursorOccurredAt < 0) throw new GatewayError(400, "INVALID_CURSOR");
          const cursorLastId = url.searchParams.get("cursorLastId");
          const limitRaw = Number(url.searchParams.get("limit") ?? 100);
          if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) throw new GatewayError(400, "INVALID_LIMIT");
          const page = cursorLastId !== null
            ? conversationPage(options.store, sessionId, { cursorOccurredAt, cursorLastId, limit: limitRaw })
            : conversationPage(options.store, sessionId, { cursorOccurredAt, limit: limitRaw });
          sendJson(response, 200, { ...page, items: page.items.map(item => ({ source: item.source, itemId: item.itemId, kind: item.kind, occurredAt: item.occurredAt })) });
          return;
        }
        if (url.pathname === "/api/v1/events" && request.method === "GET") {
          const lastEventId = request.headers["last-event-id"];
          if (Array.isArray(lastEventId)) throw new GatewayError(400, "DUPLICATE_CREDENTIAL_HEADERS");
          const cursor = parseEventCursor(lastEventId as string | undefined, url.searchParams.get("from"));
          const requestedProject = url.searchParams.get("projectId");
          const projectIds = requestedProject === null
            ? (options.store.db.prepare("SELECT id FROM projects ORDER BY id").all() as { id: string }[]).map(row => row.id)
            : [requestedProject];
          if (requestedProject !== null && !options.store.db.prepare("SELECT 1 FROM projects WHERE id=?").get(requestedProject)) throw new GatewayError(404, "NOT_FOUND");
          const cookieValue = sessionCookieValue(headers);
          // ZR-05：每次发送前用原凭据重新认证；撤销/到期/漂移即关闭流。
          const authorize = (): boolean => {
            try { authenticate(options.store, cookieValue, null, "events", now()); return true; }
            catch { return false; }
          };
          if (!authorize()) throw new GatewayError(401, "UNAUTHENTICATED");
          openEventStream(response, { store: options.store, projectIds, fromSequence: cursor, authorize });
          return;
        }
        if (url.pathname === "/api/v1/commands" && request.method === "POST") {
          if (!options.commandRunner) { sendJson(response, 404, { error: "COMMANDS_NOT_ENABLED" }); return; }
          const body = await readBody(request, changesetBodyLimit);
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { throw new GatewayError(400, "INVALID_JSON_BODY"); }
          authenticate(options.store, sessionCookieValue(headers), headers.csrf[0] ?? null, "write", now());
          try {
            const receipt = options.commandRunner(principal.principalId, parsed);
            sendJson(response, 200, receipt as Record<string, unknown>);
          } catch (error) {
            const message = String((error as Error)?.message ?? "");
            const status = options.commandErrorStatus ? options.commandErrorStatus(message) : 400;
            sendJson(response, status, { error: message.slice(0, 128) });
          }
          return;
        }
        throw new GatewayError(404, "NOT_FOUND");
      } catch (error) {
        if (error instanceof GatewayError) sendJson(response, error.status, { error: error.code });
        else if (/UNAUTHENTICATED|CSRF/.test(String((error as Error)?.message ?? ""))) sendJson(response, 401, { error: "UNAUTHENTICATED" });
        else sendJson(response, 403, { error: "GATEWAY_REJECTED" });
      }
    })();
  });
  const port = await listenBrowserLoopback(server);
  config = localOrigin(`http://127.0.0.1:${port}`);
  return Object.freeze({
    server, origin: config, port,
    close: () => {
      if(closePromise)return closePromise;
      closing = true;
      closePromise=new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        // 同步写入已完成；未收齐请求体及长连接不能无限阻塞停止，异步续体仍须重验closing。
        server.closeAllConnections();
      });
      return closePromise;
    },
  });
}
