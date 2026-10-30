/** T051：兼容表只记载实际测过的构建与能力。未命中不拒绝运行，也不冒称测试通过。 */
import { readFileSync, existsSync } from "node:fs";
import { nativeCapabilities, type NativeCapability, type NativeCapabilityProof, type NativeIdentity, NativeCompatibilityRegistry, type NativeCapabilityDecision } from "../native/compatibility.js";

export interface MatrixEntry {
  readonly identity: NativeIdentity;
  readonly capabilities: Readonly<Partial<Record<NativeCapability, "verified" | "unsupported">>>;
  readonly evidence: string;
  readonly testedAt: string;
}

export interface CompatibilityMatrix {
  readonly schemaVersion: 1;
  readonly entries: readonly MatrixEntry[];
}

const identityKey = (i: NativeIdentity): string => JSON.stringify([i.harnessId, i.version, i.executableSha256, i.bundleSha256, i.adapterProtocol, i.route]);

/** 历史测试记录是可选诊断数据；无记录不影响原生接入。损坏的数据仍明确报错。 */
export function loadCompatibilityMatrix(matrixPath: string): CompatibilityMatrix {
  if (!existsSync(matrixPath)) return { schemaVersion: 1, entries: [] };
  const raw = JSON.parse(readFileSync(matrixPath, "utf8")) as { identityMatrix?: CompatibilityMatrix } & CompatibilityMatrix;
  // 兼容两种形态：独立矩阵文件（顶层entries）或融合清单（identityMatrix字段，保留G1历史段）
  const parsed = raw.identityMatrix ?? raw;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error("INVALID_COMPATIBILITY_MATRIX");
  const seen = new Set<string>();
  for (const entry of parsed.entries) {
    const key = identityKey(entry.identity);
    if (seen.has(key)) throw new Error("DUPLICATE_MATRIX_IDENTITY");
    seen.add(key);
    for (const [capability, state] of Object.entries(entry.capabilities ?? {})) {
      if (!nativeCapabilities.includes(capability as NativeCapability) || !["verified", "unsupported"].includes(String(state))) throw new Error("INVALID_MATRIX_CAPABILITY");
    }
  }
  return parsed;
}

export interface GateResult {
  readonly registered: boolean;
  readonly reason: "matrix_match" | "not_previously_tested";
  readonly matrixPath: string;
  readonly matchedEntry: MatrixEntry | null;
  readonly pendingReverify: readonly NativeCapability[];
}

/** 保留名称兼容现有调用方；registered 仅表示登记了历史证据，不表示运行许可。 */
export function recordStartupTestHistory(registry: NativeCompatibilityRegistry, matrix: CompatibilityMatrix, matrixPath: string, identity: NativeIdentity, probeId: string): GateResult {
  const entry = matrix.entries.find(e => identityKey(e.identity) === identityKey(identity)) ?? null;
  if (!entry) {
    return { registered: false, reason: "not_previously_tested", matrixPath, matchedEntry: null, pendingReverify: [...nativeCapabilities] };
  }
  registry.recordTrustedProbe({ identity, probeId, evidenceSha256: identity.executableSha256, capabilities: entry.capabilities } satisfies NativeCapabilityProof);
  const pendingReverify = nativeCapabilities.filter(c => !entry.capabilities[c]);
  return { registered: true, reason: "matrix_match", matrixPath, matchedEntry: entry, pendingReverify };
}
/** 兼容旧调用名；此函数不再是运行闸门。 */
export const gateStartupIdentity = recordStartupTestHistory;

const maskSha = (sha: string | null): string | null => sha === null ? null : `${sha.slice(0, 12)}…`;

export interface DoctorCapabilityRow {
  readonly capability: NativeCapability;
  readonly state: NativeCapabilityDecision["state"];
  readonly enabled: boolean;
  readonly reason: NativeCapabilityDecision["reason"];
}

export interface DoctorHarnessRow {
  readonly harnessId: string;
  readonly version: string;
  readonly executableSha256Masked: string | null;
  readonly bundleSha256Masked: string | null;
  readonly adapterProtocol: string;
  readonly inMatrix: boolean;
  readonly testedVersions: readonly { readonly version: string; readonly testedAt: string; readonly passedCapabilities: readonly NativeCapability[] }[];
  readonly capabilities: readonly DoctorCapabilityRow[];
  readonly affectedWriteActions: readonly string[];
  readonly pendingReverify: readonly NativeCapability[];
}

export interface DoctorReport {
  readonly generatedAt: number;
  readonly matrixPath: string;
  readonly matrixEntries: number;
  readonly harnesses: readonly DoctorHarnessRow[];
  readonly note: string;
}

const WRITE_ACTIONS_BY_CAPABILITY: Readonly<Record<NativeCapability, readonly string[]>> = Object.freeze({
  textInput: Object.freeze(["message_send(投递泵真实轮)", "task_attempts(执行派发)"]),
  resume: Object.freeze(["binding_resume(会话续轮)"]),
  historyRead: Object.freeze(["history_read(回执/审计读取)"]),
  queue: Object.freeze([]),
  guide: Object.freeze([]),
  nativeCancel: Object.freeze(["native_cancel"]),
  nativeApprovals: Object.freeze(["native_approvals"]),
  roleTools: Object.freeze(["role_tools(会话内意图工具: task/artifact/inbox/message)"]),
});

/** 已测试版本与当前可用能力分别展示；未知版本不是阻塞原因。 */
export function doctorReport(input: { readonly now: number; readonly matrix: CompatibilityMatrix; readonly matrixPath: string; readonly installed: readonly NativeIdentity[]; readonly registry: NativeCompatibilityRegistry }): DoctorReport {
  const harnesses: DoctorHarnessRow[] = input.installed.map(identity => {
    const inMatrix = input.matrix.entries.some(e => identityKey(e.identity) === identityKey(identity));
    const capabilities: DoctorCapabilityRow[] = nativeCapabilities.map(capability => {
      const decision = input.registry.decide(identity, capability);
      return { capability, state: decision.state, enabled: decision.enabled, reason: decision.reason };
    });
    const matrixEntry = input.matrix.entries.find(e => identityKey(e.identity) === identityKey(identity)) ?? null;
    return {
      harnessId: identity.harnessId,
      version: identity.version,
      executableSha256Masked: maskSha(identity.executableSha256),
      bundleSha256Masked: maskSha(identity.bundleSha256),
      adapterProtocol: identity.adapterProtocol,
      inMatrix,
      testedVersions: testedVersions(input.matrix, identity.harnessId),
      capabilities,
      affectedWriteActions: capabilities.filter(c => !c.enabled).flatMap(c => WRITE_ACTIONS_BY_CAPABILITY[c.capability]),
      pendingReverify: matrixEntry ? nativeCapabilities.filter(c => !matrixEntry.capabilities[c]) : [...nativeCapabilities],
    };
  });
  return {
    generatedAt: input.now,
    matrixPath: input.matrixPath,
    matrixEntries: input.matrix.entries.length,
    harnesses,
    note: "已测试版本仅供参考，不按版本或程序哈希设置运行白名单。未测构建保持未测试标识，可使用适配器已实现的能力；协议、实际接口、可信会话、权限与预算仍按运行结果校验。pendingReverify 仅为测试覆盖提示，不是运行前置条件。",
  };
}

export function testedVersions(matrix: CompatibilityMatrix, harnessId: NativeIdentity["harnessId"]): DoctorHarnessRow["testedVersions"] {
  return matrix.entries.filter(e => e.identity.harnessId === harnessId).map(e => ({ version: e.identity.version, testedAt: e.testedAt, passedCapabilities: nativeCapabilities.filter(c => e.capabilities[c] === "verified") })).filter(e => e.passedCapabilities.length > 0);
}

export function compatibilityNotice(matrix: CompatibilityMatrix, current: NativeIdentity): string {
  const versions = [...new Set(testedVersions(matrix, current.harnessId).map(e => e.version))];
  return `[compatibility] ${current.harnessId} 当前版本：${current.version}；已测试通过版本：${versions.join("、") || "暂无记录"}。测试覆盖仅供参考，不限制版本；实际接口失败时如实报错。`;
}
