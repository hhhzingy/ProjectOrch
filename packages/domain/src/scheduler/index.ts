/** T031准备切片：确定性工作流调度。输入=任务图（T027）实时启动条件评估；输出=确定顺序的可派发清单
 * （同一库状态永远产生同一顺序：按startReady过滤后以taskId字典序为最终决胜——同输入同输出，R005）；
 * 管理任务与执行任务按公平序交错（R023 fairInterleave复用）；不执行派发（派发属适配器）。
 * 管理性判定：任务id以'm-'前缀为管理任务的约定由调用方映射——本模块接受调用方传入分类函数。 */
import type { Store } from "@projectorch/persistence";
import { evaluateStartConditions } from "../tasks/index.js";
import { fairInterleave } from "../budget/index.js";

export interface DispatchableTask {
  readonly taskId: string;
  readonly state: string;
  readonly revision: number;
  readonly specRevision: number;
  readonly isManagement: boolean;
}

export interface SchedulerPlan {
  readonly projectId: string;
  readonly dispatched: readonly DispatchableTask[];
  readonly blockedCount: number;
}

/** 计算候选清单：draft/ready、无在途占位且依赖满足；确定性=按taskId字典序决胜；管理/执行按fairInterleave交错。
 * classifyManagement由调用方提供（角色体系映射，默认taskId前缀m-为管理任务）。 */
export function scheduleDispatchable(store: Store, projectId: string, options: { readonly classifyManagement?: (taskId: string) => boolean } = {}): SchedulerPlan {
  const classify = options.classifyManagement ?? ((taskId: string) => taskId.startsWith("m-"));
  const tasks = store.db.prepare("SELECT t.id,t.state,t.revision,t.spec_revision FROM tasks t WHERE t.project_id=? AND t.state IN ('draft','ready') AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.project_id=t.project_id AND a.task_id=t.id AND a.state IN ('dispatching','running','waiting_input','unknown')) ORDER BY t.id").all(projectId) as { id: string; state: string; revision: number; spec_revision: number }[];
  const dispatched: DispatchableTask[] = [];
  let blockedCount = 0;
  for (const task of tasks) {
    const evaluation = evaluateStartConditions(store, projectId, String(task.id));
    if (!evaluation.ready) { blockedCount += 1; continue; }
    dispatched.push({ taskId: String(task.id), state: String(task.state), revision: Number(task.revision), specRevision: Number(task.spec_revision), isManagement: classify(String(task.id)) });
  }
  const interleaved = fairInterleave(dispatched.map(task => ({ ...task, isManagement: task.isManagement })));
  return Object.freeze({ projectId, dispatched: Object.freeze(interleaved), blockedCount });
}
