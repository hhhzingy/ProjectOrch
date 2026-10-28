/** T043：本地网关API客户端。会话Cookie由浏览器HttpOnly承载；CSRF令牌由调用方注入（写动作）。 */

export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly objective: string;
  readonly revision: number;
  readonly planRevision: number;
  readonly userPaused: boolean;
}

export interface RoleStateSummary {
  readonly roleId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly desiredState: "enabled" | "paused" | "disabled";
  readonly bindingState: "unbound" | "provisioning" | "ready" | "error";
  readonly revision: number;
  readonly modelRevision:number;
}

/** T120监督总览行：角色/harness/模型三态/当前任务/等待原因/下一动作（只读）。 */
export interface OverviewRole {
  readonly roleId: string;
  readonly name: string;
  readonly harnessId: string | null;
  readonly desiredState: string;
  readonly bindingState: string;
  readonly modelRequested: { readonly raw: string; readonly recordedAt: number } | null;
  readonly modelResolved: { readonly modelId: string | null; readonly reasoningLevel: string | null; readonly basis: string; readonly resolvedAt: number } | null;
  readonly modelEffective: { readonly modelId: string; readonly providerId: string | null; readonly observedAt: number; readonly basis: string } | null;
  readonly modelEffectiveStatus: string;
  readonly currentTask: string | null;
  readonly attemptState: string | null;
  readonly waitingReason: string | null;
  readonly nextAction: string | null;
  readonly decisionBy?:string|null;
  readonly pendingReviews?:number;
}
export interface OverviewProject { readonly projectId: string; readonly name: string; readonly roles: readonly OverviewRole[] }

export interface RoleHistoryEntry {
  readonly revision: number;
  readonly snapshot: { readonly desiredState: string; readonly bindingState: string };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string,signal?:AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" },...(signal?{signal}:{}) });
  if (!response.ok) {
    const value = await response.json() as { error?: string | { message?: string } };
    throw new ApiError(response.status, typeof value.error === "string" ? value.error : value.error?.message ?? `${response.status}`);
  }
  return await response.json() as T;
}

let csrfToken: string | null = null;
async function postJson<T>(path: string, body: unknown, csrf = true, mayRefresh = true): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(csrf && csrfToken ? { "x-projectorch-csrf": csrfToken } : {}) }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string | { message?: string } };
  // 401发生在网关执行动作之前；仅重领CSRF后重试一次，原requestId与载荷不变。
  if (response.status === 401 && csrf && mayRefresh) {
    const renewed = await postJson<{ csrfToken: string }>("/api/v1/session/csrf", {}, false, false);
    csrfToken = renewed.csrfToken;
    return postJson(path, body, true, false);
  }
  if (!response.ok) throw new ApiError(response.status, typeof result.error === "string" ? result.error : result.error?.message ?? String(response.status));
  return result;
}

export interface UserQuestionSummary{readonly id:string;readonly taskId:string;readonly revision:number;readonly prompt:string;readonly deadline:string;}
export const api = {
  conversation:(projectId:string,roleId:string,cursor:string|null=null):Promise<ConversationPage>=>getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/conversation${cursor?'?cursor='+encodeURIComponent(cursor):''}`),
  questions:(projectId:string,cursor:string|null=null):Promise<{projectId:string;items:UserQuestionSummary[];legacyCount:number;nextCursor:string|null}>=>getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/questions${cursor?'?cursor='+encodeURIComponent(cursor):''}`),
  answerQuestion:(input:unknown):Promise<ChangeReceipt>=>postJson('/api/v1/commands',input),
  session: (): Promise<{ principalId: string; hostId: string }> => getJson("/api/v1/session"),
  pair: async (challengeId: string, oneTimeCode: string): Promise<void> => { const result = await postJson<{ csrfToken: string }>("/api/v1/pairing", { schemaVersion: 2, requestId: crypto.randomUUID(), challengeId, oneTimeCode }, false); csrfToken = result.csrfToken; },
  refreshCsrf: async (): Promise<void> => { const result = await postJson<{ csrfToken: string }>("/api/v1/session/csrf", {}, false); csrfToken = result.csrfToken; },
  createProject: (input: unknown): Promise<{ projectId: string; commandId: string }> => postJson("/api/v1/projects", input),
  applyChanges: async (input: unknown): Promise<ChangeReceipt> => {
    const receipt = await postJson<ChangeReceipt>("/api/v1/changesets", input);
    if (receipt.status === "failed") throw new ApiError(409, receipt.error?.message ?? "CHANGESET_FAILED");
    return receipt;
  },
  policy: (projectId: string): Promise<PolicySummary> => getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/policy`),
  tasks: (projectId: string, cursor: string | null = null): Promise<TaskPage> => getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  taskReview: (taskId: string): Promise<TaskReview> => getJson(`/api/v1/tasks/${encodeURIComponent(taskId)}/review`),
  taskReadiness: (taskId: string): Promise<TaskReadiness> => getJson(`/api/v1/tasks/${encodeURIComponent(taskId)}/readiness`),
  artifactContent: (artifactId: string, version: string, offset: number): Promise<ArtifactChunk> => getJson(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?version=${encodeURIComponent(version)}&offset=${offset}`),
  acceptTask: (input: unknown): Promise<ChangeReceipt> => postJson('/api/v1/commands', input),
  projects: (): Promise<{ projects: ProjectSummary[] }> => getJson("/api/v1/projects"),
  roles: (projectId: string): Promise<{ projectId: string; roles: RoleStateSummary[] }> => getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/roles`),
  roleHistory: (projectId: string, roleId: string): Promise<{ projectId: string; roleId: string; history: RoleHistoryEntry[] }> => getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/history`),
  overview: (signal?:AbortSignal): Promise<{ projects: readonly OverviewProject[] }> => getJson("/api/v1/overview",signal),
  modelPreference:(projectId:string,roleId:string):Promise<ModelPreferenceState>=>getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/model-preference`),
  setModelPreference: (input: { requestId: string; projectId: string; roleId: string; expectedRevision: number;expectedModelRevision:number; modelRequested?: string; modelId?: string; reasoningLevel?: string;resetToDefault?:boolean }): Promise<{ roleId: string; revision: number;modelRevision:number; effectiveNote: string }> => postJson("/api/v1/roles/model-preference", { schemaVersion: 2, ...input }),
};

export interface ConversationPage {readonly status:'unbound'|'observed';readonly harnessId?:string;readonly items:readonly {readonly id:string;readonly role:'user'|'assistant';readonly text:string}[];readonly nextCursor:string|null;readonly limited:boolean;}

export interface ModelPreferenceState{readonly projectId:string;readonly roleId:string;readonly revision:number;readonly modelRevision:number;readonly requested:{readonly raw:string}|null;readonly resolved:{readonly modelId:string|null;readonly reasoningLevel:string|null}|null;}

export interface PolicySummary { readonly revision: number; readonly profiles: readonly { readonly id: string; readonly revision: number }[] }
export interface ChangeReceipt { readonly status: string; readonly commandId: string; readonly error: { readonly message: string } | null }
export interface TaskSummary {
  readonly id: string; readonly revision: number; readonly specRevision: number; readonly roleId: string | null; readonly state: string;
  readonly spec: { readonly goal: string; readonly outputRequirements: readonly { readonly name: string }[]; readonly dependencies: readonly { readonly taskId: string; readonly requiredTaskRevision: number; readonly condition: string; readonly outputName?: string }[] };
}
export interface TaskPage { readonly items: readonly TaskSummary[]; readonly nextCursor: string | null; readonly snapshotRevision: number }
export interface TaskReadiness {
  readonly schemaVersion: 2; readonly taskId: string; readonly projectId: string; readonly revision: number; readonly specRevision: number; readonly planRevision: number;
  readonly userPaused: boolean; readonly dependencyReady: boolean;
  readonly blocks: readonly { readonly taskId: string; readonly requiredRevision: number; readonly currentRevision: number | null; readonly reason: string }[];
  readonly unresolvedAttempts: readonly { readonly attemptId: string; readonly specRevision: number; readonly state: string }[];
}
export interface TaskReview {
  readonly task: { readonly id: string; readonly projectId: string; readonly specRevision: number; readonly spec: { readonly acceptance: readonly { readonly ruleId: string; readonly mode: string; readonly description: string }[] } };
  readonly results: readonly { readonly id: string; readonly taskRevision: number; readonly outcome: string; readonly eligibility: string; readonly summary: string; readonly executionState: string }[];
  readonly decisions: readonly { readonly resultId: string; readonly ruleId: string; readonly decision: string; readonly reviewerPrincipalId: string; readonly evidence: unknown }[];
  readonly artifacts: readonly { readonly id: string; readonly path: string; readonly sha256: string | null; readonly version: string; readonly repositoryPath?: string | null }[];
}
export interface ArtifactChunk { readonly artifactId: string; readonly version: string; readonly offset: number; readonly content: string; readonly encoding: "utf8" | "base64"; readonly nextOffset: number | null; readonly sha256: string }
