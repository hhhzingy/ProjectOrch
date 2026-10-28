export interface LocalOrigin {
  readonly origin: string;
  readonly authority: string;
}
/** 由受信启动配置与实际监听端口形成，不能取自请求 Host/Forwarded。 */
export function localOrigin(input: string): LocalOrigin {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error("INVALID_LOCAL_ORIGIN"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port === "0" || input !== parsed.origin) throw new Error("INVALID_LOCAL_ORIGIN");
  return Object.freeze({ origin: parsed.origin, authority: parsed.host });
}

/** 仅用于配对POST。使用传输层rawHeaders和socket地址，拒绝重复的安全相关头。 */
export function assertPairingSource(config: LocalOrigin, peerAddress: string | undefined, rawHeaders: readonly string[]): void {
  const expected = localOrigin(config.origin);
  if (config.authority !== expected.authority || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddress ?? "") || !Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.length > 256) throw new Error("PAIRING_SOURCE_REJECTED");
  const values = new Map<string, string[]>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]; const value = rawHeaders[i + 1];
    if (typeof name !== "string" || typeof value !== "string" || /[\r\n\0]/.test(name + value)) throw new Error("PAIRING_SOURCE_REJECTED");
    const key = name.toLowerCase();
    if (["host", "origin", "content-type"].includes(key)) values.set(key, [...(values.get(key) ?? []), value]);
  }
  const host = values.get("host"); const origin = values.get("origin"); const contentType = values.get("content-type");
  if (host?.length !== 1 || host[0] !== expected.authority || origin?.length !== 1 || origin[0] !== expected.origin || contentType?.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0] ?? "")) throw new Error("PAIRING_SOURCE_REJECTED");
}
