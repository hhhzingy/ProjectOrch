import type { Server } from "node:http";

// WHATWG Fetch §2.9，核对日期2026-10-23：https://fetch.spec.whatwg.org/#port-blocking
// 仅使用非特权端口；以下是禁用表中>=1024的部分。OS分配的临时端口也可能命中。
const blockedHighPorts = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
export function browserHttpPortAllowed(port: number): boolean { return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 && !blockedHighPorts.has(port); }

/** 使用真实监听结果形成来源；禁用端口先关闭再重选，不降低Host/Origin校验。 */
export async function listenBrowserLoopback(server: Server): Promise<number> {
  if (server.listening) throw new Error("GATEWAY_ALREADY_LISTENING");
  try {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const fail = (error: Error) => { server.off("error", fail); reject(error); };
      server.once("error", fail);
      try {
        server.listen(0, "127.0.0.1", () => {
          server.off("error", fail); const address = server.address();
          if (address === null || typeof address === "string") reject(new Error("GATEWAY_ADDRESS_UNAVAILABLE"));
          else resolve(address.port);
        });
      } catch (error) { server.off("error", fail); reject(error); }
    });
    if (browserHttpPortAllowed(port)) return port;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
  }
  throw new Error("NO_BROWSER_SAFE_PORT");
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    throw error;
  }
}
