/** 只解释官方同会话历史；空闲、PID退出或助手文字都不能单独证明某个turn完成。 */
export function zcodeHistoryTerminal(snapshot: unknown, messages: unknown, sessionId: string, turnId: string): 'completed' | null {
  const read = snapshot as { session?: {sessionId?:unknown;status?:unknown}; projection?: {sessionId?:unknown;status?:unknown;activeToolCalls?:unknown;pendingPermissions?:unknown} } | null;
  const list = messages as {messages?:unknown} | null;
  if(!read||read.session?.sessionId!==sessionId||read.session.status!=='idle'||read.projection?.sessionId!==sessionId||read.projection.status!=='idle'||!Array.isArray(list?.messages))return null;
  if(Array.isArray(read.projection.activeToolCalls)&&read.projection.activeToolCalls.length)return null;
  if(Array.isArray(read.projection.pendingPermissions)&&read.projection.pendingPermissions.length)return null;
  const rows=list.messages as {info?:{id?:unknown;sessionID?:unknown;role?:unknown;finish?:unknown;time?:{completed?:unknown};anchor?:{turnId?:unknown;boundaryMessageId?:unknown;orderedMessageIds?:unknown;goalBoundary?:unknown}}}[];
  const turn=rows.filter(m=>m.info?.sessionID===sessionId&&m.info.anchor?.turnId===turnId);
  if(!turn.some(m=>m.info?.role==='user'))return null;
  const finals=turn.filter(m=>m.info?.role==='assistant'&&m.info.finish==='stop'&&Number.isSafeInteger(m.info.time?.completed)&&Number(m.info.time?.completed)>0);
  if(finals.length!==1)return null;
  const info=finals[0]!.info!;
  if(!Array.isArray(info.anchor?.orderedMessageIds)||!info.anchor.orderedMessageIds.includes(info.id)||typeof info.anchor.boundaryMessageId!=='string'||!info.anchor.goalBoundary)return null;
  return 'completed';
}
