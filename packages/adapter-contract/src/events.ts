/** 适配器归一化事件的准备合同；不证明原生身份、执行或投递已验证。 */
import { parseSessionRef, sameSession, type SessionRef } from "./session-ref.js";

export type ExecutionStatus = "idle" | "running" | "succeeded" | "failed" | "unknown";
export interface AdapterObservation {
  readonly session: SessionRef;
  readonly connectionEpoch: string;
  readonly sequence: number;
  readonly connected: boolean;
  readonly needsReconcile: boolean;
  readonly status: ExecutionStatus;
  readonly executionId: string | null;
}
export interface AdapterFrame {
  readonly session: SessionRef;
  readonly connectionEpoch: string;
  readonly sequence: number;
  readonly type: string;
  readonly data: unknown;
}
export interface EventAdapter {
  /** 每次连接使用新代次；此接口没有创建替代会话的方法。 */
  connect(session: SessionRef, connectionEpoch: string): void;
  disconnect(): void;
  next(): AdapterFrame | null;
}
export interface ObservationResult {
  readonly disposition: "applied" | "ignored" | "reconcile";
  readonly reason: string;
  readonly observation: AdapterObservation;
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
export function beginObservation(session: SessionRef, connectionEpoch: string): AdapterObservation {
  if (!token(connectionEpoch)) throw new Error("INVALID_CONNECTION_EPOCH");
  return Object.freeze({ session: parseSessionRef(session), connectionEpoch, sequence: 0, connected: true, needsReconcile: true, status: "unknown", executionId: null });
}
/** 未知状态继续占用；重连必须先通过新代次的快照核对。 */
export function disconnectObservation(state: AdapterObservation): AdapterObservation {
  return Object.freeze({ ...state, connected: false, needsReconcile: true, status: "unknown" });
}

export function observeFrame(state: AdapterObservation, input: unknown): ObservationResult {
  const result = (disposition: ObservationResult["disposition"], reason: string, observation = state): ObservationResult => ({ disposition, reason, observation });
  const uncertain = (reason: string, sequence = state.sequence) => result("reconcile", reason, Object.freeze({ ...state, sequence, needsReconcile: true, status: "unknown" as const }));
  if (!input || typeof input !== "object" || Array.isArray(input)) return uncertain("INVALID_FRAME");
  const frame = input as Record<string, unknown>;
  let session: SessionRef;
  try { session = parseSessionRef(frame.session); } catch { return uncertain("INVALID_SESSION"); }
  if (!sameSession(session, state.session)) return result("ignored", "OTHER_SESSION");
  if (frame.connectionEpoch !== state.connectionEpoch) return result("ignored", "STALE_CONNECTION");
  if (!state.connected) return result("ignored", "OFFLINE");
  if (Object.keys(frame).some(key => !["session", "connectionEpoch", "sequence", "type", "data"].includes(key))) return uncertain("UNKNOWN_FRAME_FIELD");
  const sequence = frame.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return uncertain("INVALID_SEQUENCE");
  const seq = sequence as number;
  if (seq <= state.sequence) return result("ignored", "DUPLICATE_OR_OLD");
  if (!frame.data || typeof frame.data !== "object" || Array.isArray(frame.data)) return uncertain("INVALID_EVENT_DATA");
  const data = frame.data as Record<string, unknown>;
  const keys = Object.keys(data);
  // 快照是当前连接上的完整执行观察；不将其解释为业务验收或可信主体。
  if (frame.type === "execution.snapshot") {
    if (keys.some(key => !["status", "executionId"].includes(key)) || !["idle", "running", "succeeded", "failed", "unknown"].includes(data.status as string)) return uncertain("INVALID_SNAPSHOT");
    const status = data.status as ExecutionStatus;
    if (status === "idle" ? data.executionId !== null : !token(data.executionId)) return uncertain("INVALID_EXECUTION_ID");
    return result("applied", "SNAPSHOT", Object.freeze({ ...state, sequence: seq, status, executionId: data.executionId as string | null, needsReconcile: status === "unknown" }));
  }
  if (seq !== state.sequence + 1) return uncertain("SEQUENCE_GAP");
  if (frame.type !== "execution.started" && frame.type !== "execution.completed") return uncertain("UNKNOWN_EVENT", seq);
  if (state.needsReconcile) return uncertain("SNAPSHOT_REQUIRED");
  const allowedKeys = frame.type === "execution.started" ? ["executionId"] : ["executionId", "outcome"];
  if (keys.some(key => !allowedKeys.includes(key)) || !token(data.executionId)) return uncertain("INVALID_EXECUTION_EVENT");
  if (frame.type === "execution.started") {
    if (state.status === "running") return uncertain("EXECUTION_CONFLICT");
    return result("applied", "STARTED", Object.freeze({ ...state, sequence: seq, status: "running", executionId: data.executionId }));
  }
  if (state.status !== "running" || data.executionId !== state.executionId) return uncertain("EXECUTION_TARGET_CHANGED");
  if (data.outcome !== "succeeded" && data.outcome !== "failed") return uncertain("INVALID_OUTCOME");
  return result("applied", "COMPLETED", Object.freeze({ ...state, sequence: seq, status: data.outcome }));
}
