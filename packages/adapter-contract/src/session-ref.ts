/** 来自受信主机的原生会话引用；结构合法不代表身份已经验证。 */
export interface SessionRef {
  readonly harnessId: string;
  readonly hostId: string;
  readonly profileId: string;
  readonly nativeConversationId: string;
  readonly nativeWorkspaceId?: string;
}

const limits = {
  harnessId: 128,
  hostId: 128,
  profileId: 128,
  nativeConversationId: 512,
  nativeWorkspaceId: 512,
} as const;

export function parseSessionRef(input: unknown): SessionRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_SESSION_REF");
  const data = input as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!Object.hasOwn(limits, key)) throw new Error("UNKNOWN_SESSION_REF_FIELD");
  for (const [key, max] of Object.entries(limits)) {
    const value = data[key];
    if (key === "nativeWorkspaceId" && !Object.hasOwn(data, key)) continue;
    if (typeof value !== "string" || !value.length || [...value].length > max) throw new Error(`INVALID_SESSION_REF_FIELD: ${key}`);
  }
  const base = { harnessId: data.harnessId as string, hostId: data.hostId as string, profileId: data.profileId as string, nativeConversationId: data.nativeConversationId as string };
  return Object.freeze(Object.hasOwn(data, "nativeWorkspaceId") ? { ...base, nativeWorkspaceId: data.nativeWorkspaceId as string } : base);
}

/** 结构身份键；不包含标题、历史内容、连接代次或角色绑定代次。 */
export function sessionKey(input: SessionRef): string {
  const ref = parseSessionRef(input);
  return JSON.stringify([ref.harnessId, ref.hostId, ref.profileId, ref.nativeConversationId, ref.nativeWorkspaceId ?? null]);
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return sessionKey(a) === sessionKey(b);
}

export interface SessionConnection {
  readonly session: SessionRef;
  readonly connectionEpoch: string;
  readonly bindingEpoch: number;
  readonly nativeExecutionId?: string;
}
