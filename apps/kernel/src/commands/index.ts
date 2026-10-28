import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import type { Store } from "@projectorch/persistence";
import { reserveCommand, commitCommandReceipt, type Receipt } from "@projectorch/persistence/commands";
import { canonicalJson } from "@projectorch/persistence/outbox";

type Command = ContractRegistry["command"];
export interface CommandServices {
  /** 受信实现必须每次核验当前主体/项目/动作权限，包含重试；没有默认放行。 */
  readonly authorize: (db: DatabaseSync, principalId: string, command: Command) => boolean;
  readonly handlers: ReadonlyMap<Command["type"], (db: DatabaseSync, commandId: string, command: Command) => unknown>;
}

function isPromise(value: unknown): boolean {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
/** 内部准备入口，无HTTP或认证适配；传入的主体只能由可信认证层产生。 */
export function createCommandRunner(store: Store, services: CommandServices): (principalId: string, input: unknown) => Receipt {
  if (typeof services.authorize !== "function" || services.authorize.constructor.name === "AsyncFunction") throw new Error("SYNC_AUTHORIZER_REQUIRED");
  const authorize = services.authorize;
  const handlers = new Map(services.handlers);
  for (const handler of handlers.values()) if (typeof handler !== "function" || handler.constructor.name === "AsyncFunction") throw new Error("SYNC_COMMAND_HANDLER_REQUIRED");
  return (principalId, input) => {
    if (typeof principalId !== "string" || !principalId.length || principalId.length > 128) throw new Error("UNAUTHENTICATED");
    const command = parseContract("command", JSON.parse(canonicalJson(input)));
    return store.transaction(db => {
      const authorized = authorize(db, principalId, command);
      // 将意外Promise原样交给Store：其回滚并关闭连接，防止迟到续体写入。
      if (isPromise(authorized)) return authorized as unknown as Receipt;
      if (authorized !== true) throw new Error("FORBIDDEN");
      const reservation = reserveCommand(db, principalId, randomUUID(), command, Date.now());
      if (reservation.replay) return reservation.receipt;
      const handler = handlers.get(command.type);
      if (!handler) throw new Error("CAPABILITY_UNSUPPORTED");
      const receipt = handler(db, reservation.commandId, command);
      if (isPromise(receipt)) return receipt as Receipt;
      return commitCommandReceipt(db, principalId, reservation.commandId, receipt);
    });
  };
}
