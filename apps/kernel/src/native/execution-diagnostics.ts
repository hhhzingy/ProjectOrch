/** 只允许固定故障码和有限计量进入审计，不能存储Error.message、stderr或任意原生字段。 */
const codes = new Set(['CLI_TIMEOUT','CLI_CHILD_EXIT_UNCONFIRMED','CLI_TERMINATED_UNCERTAIN','CLI_EXIT_UNCERTAIN','CLI_INVALID_FRAME','CLI_RESULT_ERROR','CLI_RESULT_MISSING','CLI_SESSION_MISMATCH','CLI_TURN_MISMATCH','CLI_OUTPUT_LIMIT','CLI_TRUNCATED_FRAME','CLI_DATA_AFTER_RESULT','CLI_INVALID_RESULT','EXECUTION_DEADLINE_REACHED','NATIVE_EXECUTION_UNCERTAIN','CODEX_USAGE_LIMIT_EXCEEDED']);
const frameTypes = new Set(['turn.started','system','assistant','tool','result']);
export interface ExecutionDiagnostic { readonly code:string; readonly elapsedMs?:number; readonly frames?:number; readonly stdoutBytes?:number; readonly lastType?:string; }
export function safeExecutionDiagnostic(value:unknown): ExecutionDiagnostic {
  const input=value && typeof value==='object'?value as Record<string,unknown>:{};
  const result: {code:string;elapsedMs?:number;frames?:number;stdoutBytes?:number;lastType?:string}={code:typeof input.code==='string'&&codes.has(input.code)?input.code:'NATIVE_EXECUTION_UNCERTAIN'};
  for(const key of ['elapsedMs','frames','stdoutBytes'] as const){const n=input[key];if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)result[key]=n;}
  if(typeof input.lastType==='string')result.lastType=frameTypes.has(input.lastType)?input.lastType:'unknown';
  return Object.freeze(result);
}
