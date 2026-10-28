/** T051：doctor与兼容漂移处理。兼容矩阵=先前真实探针固化的身份→能力证据（config/compatibility.json）；
 * gateStartupIdentity=启动登记闸门：身份在矩阵内→按矩阵登记（有据verified/unsupported）；
 * 不在→不登记（漂移，decide按unverified拒绝受影响写动作）——杜绝"凭上次成功永久verified"。
 * doctorReport=脱敏诊断（sha截断、版本明示、待复验能力清单、受影响自动写动作、其余harness不受影响）。 */
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

/** 读取+校验兼容矩阵。矩阵是交付数据：只含实测身份与探针结论，不存在默认放行。 */
export function loadCompatibilityMatrix(matrixPath: string): CompatibilityMatrix {
  if (!existsSync(matrixPath)) throw new Error(`COMPATIBILITY_MATRIX_MISSING: ${matrixPath}`);
  const raw = JSON.parse(readFileSync(matrixPath, "utf8")) as { identityMatrix?: CompatibilityMatrix } & CompatibilityMatrix;
  // 兼容两种形态：独立矩阵文件（顶层entries）或融合清单（identityMatrix字段，保留G1历史段）
  const parsed = raw.identityMatrix ?? raw;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.length) throw new Error("INVALID_COMPATIBILITY_MATRIX");
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
  readonly reason: "matrix_match" | "identity_drift";
  readonly matrixPath: string;
  readonly matchedEntry: MatrixEntry | null;
  readonly pendingReverify: readonly NativeCapability[];
}

/** 启动登记闸门：矩阵匹配→登记矩阵结论；漂移→不登记（返回待复验清单）。绝不无条件verified。 */
export function gateStartupIdentity(registry: NativeCompatibilityRegistry, matrix: CompatibilityMatrix, matrixPath: string, identity: NativeIdentity, probeId: string): GateResult {
  const entry = matrix.entries.find(e => identityKey(e.identity) === identityKey(identity)) ?? null;
  if (!entry) {
    return { registered: false, reason: "identity_drift", matrixPath, matchedEntry: null, pendingReverify: [...nativeCapabilities] };
  }
  registry.recordTrustedProbe({ identity, probeId, evidenceSha256: identity.executableSha256, capabilities: entry.capabilities } satisfies NativeCapabilityProof);
  const pendingReverify = nativeCapabilities.filter(c => !entry.capabilities[c]);
  return { registered: true, reason: "matrix_match", matrixPath, matchedEntry: entry, pendingReverify };
}

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

/** 脱敏诊断：逐harness输出当前身份、矩阵匹配、能力判定与受影响自动写动作。
 * 身份键按harness隔离：任一harness漂移只停自身写动作，不影响其余harness/项目。 */
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
      capabilities,
      affectedWriteActions: capabilities.filter(c => !c.enabled && c.state !== "unverified" || c.state === "unverified" && WRITE_ACTIONS_BY_CAPABILITY[c.capability].length > 0).flatMap(c => WRITE_ACTIONS_BY_CAPABILITY[c.capability]),
      pendingReverify: matrixEntry ? nativeCapabilities.filter(c => !matrixEntry.capabilities[c]) : [...nativeCapabilities],
    };
  });
  return {
    generatedAt: input.now,
    matrixPath: input.matrixPath,
    matrixEntries: input.matrix.entries.length,
    harnesses,
    note: "能力结论只认矩阵内同身份（版本+双哈希+协议）先前真实探针证据；身份漂移→受影响自动写动作停止并列出待复验能力；其余harness与项目不受影响。",
  };
}
