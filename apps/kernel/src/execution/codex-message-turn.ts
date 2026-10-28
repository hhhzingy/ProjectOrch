import type { CodexAdapter, TurnReceipt } from "../adapters/codex-adapter.js";
import type { NativeModelSelection } from '../native/model-selection.js';

/** 消息生产路径：恢复与实际传输写入都复核同一消息授权。 */
export async function runCodexMessageTurn(
  adapter: Pick<CodexAdapter, "resumeThread" | "runTurn">,
  conversationId: string,
  input: string,
  timeoutMs: number,
  assertCurrent: () => void,
  selection?:NativeModelSelection,
  onTurnStarted?:(turnId:string)=>void,
): Promise<TurnReceipt> {
  assertCurrent();
  await adapter.resumeThread(conversationId);
  assertCurrent();
  return adapter.runTurn(input, "", timeoutMs, onTurnStarted, assertCurrent,selection);
}
