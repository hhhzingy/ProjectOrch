/** T110：受管角色主体HTTP工具面——agent凭据→角色工具（mcp-catalog+gateway-tools派发器）。
 * 逐请求核销：每次调用重新assertAgentPrincipalCurrent（凭据撤销/绑定结束即拒）。
 * callerNativeConversationId取凭据内权威会话（不可由请求正文自报）。 */
import type { Store } from "@projectorch/persistence";
import { authenticateAgentCredential, assertAgentPrincipalCurrent } from "../auth/agent-credential.js";
import { createToolDispatcher } from "./gateway-tools.js";
import { mcpToolEntries, mcpToolDescription, mcpToolArguments } from "./mcp-catalog.js";
import type { McpBackend } from "./mcp-http-host.js";
import {ContractError} from '@projectorch/contracts';
import {roleTurnExecution} from '../auth/role-turn-credential.js';

export function buildRoleToolBackend(store: Store, token: string): McpBackend | null {
  try {
    const principal = authenticateAgentCredential(store, token, Date.now());
    assertAgentPrincipalCurrent(store, principal, Date.now());
    let closed=false,observedExecution:string|undefined;
    const assertConnection=()=>{
      if(closed)throw Error('ROLE_TOOL_CONNECTION_CLOSED');assertAgentPrincipalCurrent(store,principal,Date.now());
      const execution=roleTurnExecution(store,principal);if(observedExecution!==undefined&&execution!==observedExecution)throw Error('ROLE_TURN_NOT_CURRENT');
      observedExecution=execution;return execution;
    };
    return {
      list: () => mcpToolEntries.map(mcpToolDescription),
      call: (name: string, args: unknown) => {
        try {
          assertAgentPrincipalCurrent(store, principal, Date.now());
          const entry = mcpToolEntries.find(e => e.name === name);
          if (!entry) return { ok: false, payload: { error: "TOOL_UNKNOWN" } };
          const execution=assertConnection(),dispatcher=createToolDispatcher(store,{now:()=>Date.now(),callerNativeConversationId:principal.session.nativeConversationId,...(execution?{callerNativeExecutionId:execution}:{}),assertTrustedConnection:()=>{assertConnection();}});
          const result = dispatcher(principal, entry.tool, mcpToolArguments(entry, args));
          return { ok: result.ok, payload: result.payload };
        } catch (error) { return { ok: false, payload: { error: String((error as Error).message).slice(0, 120),...(error instanceof ContractError?{issues:error.issues}:{}) } }; }
      },
      closed: () => {closed=true;},
    };
  } catch { return null; }
}
