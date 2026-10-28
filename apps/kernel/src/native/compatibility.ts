/** 原生升级兼容状态：只消费可信探针记录，不修改/启动原生软件，不推断未知版本支持。 */
export const nativeCapabilities = Object.freeze(["textInput", "resume", "historyRead", "queue", "guide", "nativeCancel", "nativeApprovals", "roleTools"] as const);
export type NativeCapability = typeof nativeCapabilities[number];
export type NativeRoute = "official_cli" | "official_rpc" | "official_extension";
export interface NativeIdentity {
  readonly harnessId: "codex" | "zcode";
  readonly version: string;
  readonly executableSha256: string;
  readonly bundleSha256: string | null;
  readonly adapterProtocol: string;
  readonly route: NativeRoute;
}
export interface NativeCapabilityProof {
  readonly identity: NativeIdentity;
  readonly probeId: string;
  readonly evidenceSha256: string;
  readonly capabilities: Readonly<Partial<Record<NativeCapability, "verified" | "unsupported">>>;
}
export interface NativeCapabilityDecision {
  readonly state: "verified" | "unsupported" | "unverified";
  readonly enabled: boolean;
  readonly reason: "matching_probe" | "unsupported_by_official_route" | "native_or_adapter_updated" | "probe_required" | "capability_not_probed";
}
const shaPattern = /^[a-f0-9]{64}$/;
function identity(input: NativeIdentity): NativeIdentity {
  if (!input || Object.keys(input).some(k => !["harnessId", "version", "executableSha256", "bundleSha256", "adapterProtocol", "route"].includes(k)) || !["codex", "zcode"].includes(input.harnessId) || typeof input.version !== "string" || !input.version || input.version.length > 128 || typeof input.adapterProtocol !== "string" || !input.adapterProtocol || input.adapterProtocol.length > 128 || !shaPattern.test(input.executableSha256) || (input.bundleSha256 !== null && !shaPattern.test(input.bundleSha256)) || !["official_cli", "official_rpc", "official_extension"].includes(input.route)) throw new Error("INVALID_OFFICIAL_NATIVE_IDENTITY");
  return Object.freeze({ harnessId: input.harnessId, version: input.version, executableSha256: input.executableSha256, bundleSha256: input.bundleSha256, adapterProtocol: input.adapterProtocol, route: input.route });
}
const key = (i: NativeIdentity) => JSON.stringify([i.harnessId, i.version, i.executableSha256, i.bundleSha256, i.adapterProtocol, i.route]);

/** 记录入口仅供内核可信验证器使用，不是浏览器/Agent可自报verified的API。 */
export class NativeCompatibilityRegistry {
  readonly #proofs = new Map<string, NativeCapabilityProof>();
  readonly #seenHarnesses = new Set<string>();
  recordTrustedProbe(input: NativeCapabilityProof): void {
    const target = identity(input.identity);
    if (typeof input.probeId !== "string" || !input.probeId || input.probeId.length > 128 || !shaPattern.test(input.evidenceSha256) || !input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) throw new Error("INVALID_NATIVE_PROOF");
    const capabilities: Partial<Record<NativeCapability, "verified" | "unsupported">> = {};
    for (const [capability, state] of Object.entries(input.capabilities)) {
      if (!nativeCapabilities.includes(capability as NativeCapability) || !["verified", "unsupported"].includes(state)) throw new Error("INVALID_NATIVE_CAPABILITY_PROOF");
      capabilities[capability as NativeCapability] = state;
    }
    this.#proofs.set(key(target), Object.freeze({ identity: target, probeId: input.probeId, evidenceSha256: input.evidenceSha256, capabilities: Object.freeze(capabilities) }));
    this.#seenHarnesses.add(target.harnessId);
  }
  decide(input: NativeIdentity, capability: NativeCapability): NativeCapabilityDecision {
    const current = identity(input);
    if (!nativeCapabilities.includes(capability)) throw new Error("UNKNOWN_NATIVE_CAPABILITY");
    const proof = this.#proofs.get(key(current));
    if (!proof) return Object.freeze({ state: "unverified", enabled: false, reason: this.#seenHarnesses.has(current.harnessId) ? "native_or_adapter_updated" : "probe_required" });
    const state = proof.capabilities[capability];
    if (!state) return Object.freeze({ state: "unverified", enabled: false, reason: "capability_not_probed" });
    return Object.freeze({ state, enabled: state === "verified", reason: state === "verified" ? "matching_probe" : "unsupported_by_official_route" });
  }
}
