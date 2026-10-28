/** 原生轮执行墙钟（Execution Deadline），与单次RPC请求等待严格分开。 */
export interface ExecutionTimeoutOptions {
  /** 向后兼容别名：原有显式值仍是整个原生轮期限，不是RPC超时。 */
  readonly timeoutMs?: number;
  readonly executionTimeoutMs?: number;
}
export const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60_000;
export const MAX_EXECUTION_TIMEOUT_MS = 30 * 60_000;
export function executionTimeout(options: ExecutionTimeoutOptions, code = 'INVALID_EXECUTION_TIMEOUT'): number {
  for (const value of [options.timeoutMs, options.executionTimeoutMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXECUTION_TIMEOUT_MS)) throw new Error(code);
  }
  if (options.timeoutMs !== undefined && options.executionTimeoutMs !== undefined && options.timeoutMs !== options.executionTimeoutMs) throw new Error('CONFLICTING_EXECUTION_TIMEOUT');
  return options.executionTimeoutMs ?? options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
}
export function rpcRequestTimeout(value: number | undefined): number {
  const timeout = value ?? 20_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('INVALID_RPC_TIMEOUT');
  return timeout;
}
