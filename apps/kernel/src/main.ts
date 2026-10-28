import {executionTimeout, rpcRequestTimeout, type ExecutionTimeoutOptions} from './native/execution-timeout.js';
import { applicationInfo, assertSupportedNode } from "@projectorch/runtime";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { startApplication } from "./lifecycle/application.js";
import { issuePairingChallenge } from "./auth/pairing.js";

/** 复核二段：普通用户原生环境配置——JSON文件而非JS回调。--native <path> 或默认 <dataDir>/native-config.json。
 * 字段（均可选；不含认证材料——认证由官方CLI自身登录态提供，进程继承用户环境变量）：
 * { "zcode": {"executable","bundle","executionTimeoutMs?","timeoutMs?"}, "codex": {"executable","executionTimeoutMs?","rpcTimeoutMs?","timeoutMs?"},
 *   "leaseDirectory?": 默认 <dataDir>/leases, "workspaceRoot?": 默认 <dataDir>/workspaces } */
function loadNativeOptions(dataDirectory: string, explicitPath: string | null): Parameters<typeof startApplication>[1] {
  const configPath = explicitPath ?? path.join(dataDirectory, "native-config.json");
  if (!existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as { zcode?: ExecutionTimeoutOptions & { executable?: string; bundle?: string }; codex?: ExecutionTimeoutOptions & { executable?: string; rpcTimeoutMs?: number; sharedLogin?: boolean }; leaseDirectory?: string; workspaceRoot?: string; zcodeEnv?: Record<string, string>; }
  for(const native of [raw.zcode,raw.codex])if(native)executionTimeout(native);
  if(raw.codex)rpcRequestTimeout(raw.codex.rpcTimeoutMs);
  const leaseDirectory = raw.leaseDirectory && path.isAbsolute(raw.leaseDirectory) ? raw.leaseDirectory : path.join(dataDirectory, "leases");
  if(raw.workspaceRoot && !path.isAbsolute(raw.workspaceRoot))throw new Error('ABSOLUTE_WORKSPACE_ROOT_REQUIRED');
  const workspaceRoot = raw.workspaceRoot;
  mkdirSync(leaseDirectory, { recursive: true }); if(workspaceRoot)mkdirSync(workspaceRoot, { recursive: true });
  // 环境来源（复核修复）：显式 zcodeEnv 优先（非Desktop宿主如外部启动器/codex exec 无 ZCODE_* 继承，
  // 必需变量见 docs/config-samples/native-config.example.json——非认证材料）；缺省回退继承当前进程。
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) { const v = process.env[key]; if (v) env[key] = v; }
  for (const key of ["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_BASE_URL", "ZCODE_ENV", "ZCODE_DATA_BASE_DIR"]) {
    const explicit = raw.zcodeEnv?.[key];
    if (typeof explicit === "string" && explicit) env[key] = explicit;
    else { const v = process.env[key]; if (v) env[key] = v; }
  }
  const workspaceForTask = (projectId: string, taskId: string, bindingId: string): string => {
    if(!workspaceRoot)throw new Error('EXPLICIT_WORKSPACE_ROOT_REQUIRED');
    // 绑定工作目录稳定且按身份隔离；任务切换不能把角色工具配置移到另一个cwd。
    const key = Buffer.from(JSON.stringify([projectId, bindingId || taskId])).toString('base64url');
    const ws = path.join(workspaceRoot, key); mkdirSync(ws, { recursive: true }); return ws;
  };
  const zcode = raw.zcode?.executable && raw.zcode.bundle ? { executable: raw.zcode.executable, bundle: raw.zcode.bundle, env, leaseDirectory, timeoutMs: executionTimeout(raw.zcode) } : null;
  const codex = raw.codex?.executable ? { executable: raw.codex.executable, profileDirectory: path.join(dataDirectory, "codex-profile"), leaseDirectory, timeoutMs: executionTimeout(raw.codex), rpcTimeoutMs: rpcRequestTimeout(raw.codex.rpcTimeoutMs), ...(raw.codex.sharedLogin === true ? { sharedLogin: true } : {}) } : null;
  const native = { ...(workspaceRoot ? {workspaceForTask} : {}), ...(zcode ? { zcode } : {}), ...(codex ? { codex } : {}) };
  return { native };
}

async function main(): Promise<void> {
  assertSupportedNode(process.version);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("ProjectOrch 本地控制台\n--data-dir <绝对本地目录>  数据目录\n--native <绝对路径>  原生环境配置JSON（默认 <数据目录>/native-config.json）\n--check  启动检查后退出\n--pair  在交互终端显示一次性配对信息\n");
    return;
  }
  let directory = process.env.PROJECTORCH_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "ProjectOrch");
  let nativeConfigPath: string | null = null;
  let check = false; let pair = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--pair") pair = true;
    else if (arg === "--data-dir" && args[i + 1] && !args[i + 1]?.startsWith("--")) directory = args[++i] as string;
    else if (arg === "--native" && args[i + 1] && !args[i + 1]?.startsWith("--")) nativeConfigPath = args[++i] as string;
    else throw new Error("INVALID_START_ARGUMENT");
  }
  if (pair && (!process.stdout.isTTY || check)) throw new Error("PAIRING_REQUIRES_INTERACTIVE_TERMINAL");
  const runtime = await startApplication(directory, loadNativeOptions(directory, nativeConfigPath));
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= runtime.stop().finally(() => { process.removeListener("message", onMessage); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); if (process.connected) process.disconnect(); });
    return stopping;
  };
  const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
  // IPC仅面向自建可信本机启动器，不是HTTP/Agent入口；配对秘密不进入stdout日志。
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === "shutdown") onSignal();
    if (type === "pair" && process.connected && !stopping) process.send?.({ type: "pairing", ...issuePairingChallenge(runtime.store) });
  };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.on("message", onMessage);
  try {
    process.stdout.write(`${JSON.stringify({ ...applicationInfo, status: "ready", origin: runtime.gateway.origin.origin })}\n`);
    if (pair) {
      // 用户显式选择的受信本地终端UI；重定向/自动化环境拒绝显示秘密。
      const challenge = issuePairingChallenge(runtime.store);
      process.stdout.write(`一次性配对：${JSON.stringify(challenge)}\n`);
    }
    if (check) await stop();
  } catch (error) { await stop(); throw error; }
}
void main().catch(error => { process.stderr.write(`ProjectOrch启动失败：${String((error as Error)?.message ?? "START_FAILED").slice(0, 200)}\n`); process.exitCode = 1; });
