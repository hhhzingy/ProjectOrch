import { parseToolArguments, toolArgumentSchema } from "@projectorch/contracts";

interface Entry { readonly tool: string; readonly source: "command" | "query" | "message" | "result" | "changeset"; readonly variant: string; readonly description: string }
// 只列已实现且有固定输入合同的工具；管理/用户保留动作不因MCP暴露而获得权限。
const entries: readonly Entry[] = [
  {tool:'integration.run.read',source:'query',variant:'integration.run.read',description:'读取本集成精确run的真实内置检查证据、逐断言结果与准确目标清单/指纹。每次核对integration/task/check/workspace及目标各路径权限。只读历史事实，不重跑、不将通过文字代替独立裁决，不证明当前目标仍未变化。'},
  {tool:'check.read',source:'query',variant:'check.read',description:'读取本项目已授权范围的固定检查定义和启用状态。只能引用既有版本，不能注册或替换代码。旧裸定义缺固定合同字段时明确要求修复；已登记不自动证明已实际运行。'},
  ...['integration.evaluate','integration.review'].map(tool=>({tool,source:'command' as const,variant:tool,description:'指定独立复核角色的集成验证。evaluate固定整合后实际目标并运行用户已批准的纯数据JSON检查，必须已有真实整合任务终态/已验收输入，返回准确目标与run IDs；只读内置验证器目前不支持registered_process。review只消费本目标/当前规格/精确run IDs和本人复核任务的证据，全部检查过且独立才verified；拒绝须repairTaskId。请求基线与整合后输出分开；不自动接受任务或项目，不清unknown或扩权。'})),
  {tool:'role.provision',source:'command',variant:'role.provision',description:'为本人子角色创建受管官方会话，harnessId显式指定，需已有role.bind授权。缺省只允许未绑定角色；传handoverId即明确创建新会话接替，须当前独立核验包、旧运行已核对，原子消费/换绑并撤销旧凭据，不冒充同会话恢复。不能扩权限/预算或绑定任意已有对话；返回operationId，pending不等于ready，unknown只核对原动作不盲目重建。'},
  ...['handover.prepare','handover.verify','integration.request'].map(tool=>({tool,source:'command' as const,variant:tool,description:'提交版本化交接或集成请求。交接成果须为已登记JSON并声明projectId/roleId/fromBindingEpoch，核验者必须独立；集成请求不执行合并、不表示检查通过。身份取当前连接，所有成果继续核验实际内容及权限。'})),
  ...['handover.read','integration.read'].map(tool=>({tool,source:'query' as const,variant:tool,description:'读取当前项目授权范围内的固定交接或集成记录；旧记录缺合同字段时明确要求修复。'})),
  ...['question.read','question.list'].map(tool=>({tool,source:'query' as const,variant:tool,description:'读取当前授权范围的持久业务问题；缺失旧合同字段明确要求修复，不伪造期限策略。列表游标绑定当前主体、权限及内容快照。'})),
  ...['question.ask','question.answer'].map(tool=>({tool,source:'command' as const,variant:tool,description:'持久业务问答，不是原生审批。提问绑定当前执行/规格/代次，只创建问题；需要等待时另调用task.report.wait。回答仅限指定角色/已认证用户，业务答案不代表原生终态或任务通过；具备message.send时可排队通知。'+(tool==='question.ask'?' 前置：task.read确认真实currentAttempt；任务draft/ready必须先task.claim，用entity revision作为expectedRevision、specRevision作为expectedSpecRevision，成功后再提问。attempt running本身不代表任务active。QUESTION_EXECUTION_NOT_CURRENT须核对任务是否已领取以及原尝试/绑定，不伪造ID或盲重发。':'' )})),
  {tool:'management.apply_changes',source:'changeset',variant:'',description:'按固定变更集一次创建/调整多个角色和任务，原子保存并返回持久回执。role.create每项必含type/localRef/name/charter/scopePaths/permissionProfileId/permissionProfileRevision，parentRoleId须为本人。需要change.apply及每种operation当前动作/路径授权；档案/路径/再委派不得扩权。MCP参数不含schemaVersion或projectId，由连接注入。原生会话仍待显式受管绑定，不把角色登记当ready；不能降低验收。某些客户端将复杂operations简化显示为unknown；仍须按固定结构传JSON，不是任意参数。本服务器不提供resources/templates用于查询Schema。任务创建示例（替换ID/水位和业务内容）：{"requestId":"unique-key","expectedPlanRevision":0,"reason":"规划一个执行批次","operations":[{"type":"task.create","localRef":"work","assigneeRoleId":"actual-role-id","spec":{"goal":"完成实际需求","inputArtifacts":[],"outputRequirements":[{"name":"report","kind":"file","description":"真实文件"}],"acceptance":[{"ruleId":"review","mode":"designated_reviewer","reviewerRoleId":"actual-reviewer-role-id","independent":true,"description":"实际核对产物"}],"dependencies":[]}}]}。真实项目取project.snapshot的planRevision，工具返回具体issues时按issues修正；不反复寻找不存在的MCP资源。'},
  { tool: "identity", source: "query", variant: "identity", description: "读取当前连接的可信身份，不接受角色或会话覆盖。" },
  {tool:'project.snapshot',source:'query',variant:'project.snapshot',description:'读取当前项目目标、暂停和计划/策略/目标水位版本，供管理变更和启动握手使用；只返回有role.read授权的角色摘要，不接受跨项目读取。'},
  { tool: "task.read", source: "query", variant: "task.read", description: "读取已授权任务规格、currentAttempt和结果引用。提交成果/结果的taskRevision取specRevision或currentAttempt.taskRevision；顶层revision是实体版本，不能代替规格版本。" },
  { tool: "result.read", source: "query", variant: "result.read", description: "用task.read返回的resultId读取结果、执行状态、授权outputs及服务器持久decisions（ID/规格/规则/裁决/可信复核角色/时间/可读证据）；按任务与每条证据授权，受限证据隐藏ID及原因正文。不把执行者摘要当验收证据，实际文件经artifact.read/content核对。" },
  { tool: "task.list", source: "query", variant: "task.list", description: "按授权任务范围分页读取；游标不能跨版本、角色或策略复用。" },
  { tool: "policy.read", source: "query", variant: "policy.read", description: "读取本项目当前版本策略；此工具不能更改权限。" },
  { tool: "role.read", source: "query", variant: "role.read", description: "读取已授权角色的职责、版本和期望/绑定状态；不含认证秘密。" },
  { tool: "role.list", source: "query", variant: "role.list", description: "分页读取本项目已授权角色职责和状态；游标绑定当前主体及授权快照。" },
  { tool: "inbox.read", source: "query", variant: "inbox.read", description: "分页读取当前角色的持久收件箱；roleId只能是当前可信角色，状态改变后旧游标失效。" },
  ...["role.startup_ack", "task.claim", "task.report", "task.accept", "message.ack", "artifact.register", "issue.raise"].map(tool => ({ tool, source: "command" as const, variant: tool, description: `提交${tool}。requestId用于持久幂等，回执不等于原生执行完成；身份和原生执行标识由内核连接固定。` })),
  { tool: "message.send", source: "message", variant: "", description: "持久发送消息；发送方取连接身份，不能自报。" },
  { tool: "task.submit_result", source: "result", variant: "", description: "提交本人尝试结果，taskRevision取specRevision，attemptId取currentAttempt.id；MCP参数不含schemaVersion或projectId，内核按连接注入。outcome只能succeeded/failed/inconclusive；checks和remainingIssues没有条目时填[]，具名outputs按Schema；不能自行验收。" },
  { tool: "artifact.read", source: "query", variant: "artifact.read", description: "读取已授权成果登记元数据；不提供任意文件路径读取。" },
  { tool: "artifact.content", source: "query", variant: "artifact.content", description: "按登记版本和字节offset读取成果分片；encoding为utf8或base64，sha256为完整内容哈希，nextOffset为空表示结束。Git仅返回提交对象原始内容。" },
];
export const mcpToolEntries = Object.freeze(entries.map(entry => Object.freeze({ ...entry, name: `projectorch_${entry.tool.replaceAll(".", "_")}` })));
// 某些Harness忽略const/enum推断，将数字2渲染成字符串。补等价显式类型，不改严格参数合同。
function explicitLiteralTypes(schema:Record<string,unknown>):void{
  const primitive=(value:unknown):string|null=>value===null?'null':typeof value==='string'?'string':typeof value==='boolean'?'boolean':typeof value==='number'?(Number.isInteger(value)?'integer':'number'):null;
  if(schema.type===undefined){
    if(Object.hasOwn(schema,'const')){const type=primitive(schema.const);if(type)schema.type=type;}
    else if(Array.isArray(schema.enum)&&schema.enum.length){const types=schema.enum.map(primitive);if(types[0]&&types.every(type=>type===types[0]))schema.type=types[0];}
  }
  for(const name of ['properties','$defs','definitions','patternProperties']){const values=schema[name];if(values&&typeof values==='object'&&!Array.isArray(values))for(const value of Object.values(values))if(value&&typeof value==='object'&&!Array.isArray(value))explicitLiteralTypes(value as Record<string,unknown>);}
  for(const name of ['oneOf','anyOf','allOf','prefixItems'])if(Array.isArray(schema[name]))for(const value of schema[name])if(value&&typeof value==='object'&&!Array.isArray(value))explicitLiteralTypes(value as Record<string,unknown>);
  for(const name of ['items','additionalProperties','if','then','else','not','contains']){const value=schema[name];if(value&&typeof value==='object'&&!Array.isArray(value))explicitLiteralTypes(value as Record<string,unknown>);}
}
export function mcpToolDescription(entry: typeof mcpToolEntries[number]) {
  const schema = toolArgumentSchema(entry.source, entry.variant);
  // 部分官方客户端仅从根properties生成工具参数。保留oneOf完整校验，
  // 同时将分支字段投影到根对象，避免模型侧将合法工具误读为零参数工具。
  if (Array.isArray(schema.oneOf) && !schema.properties) {
    const branches = schema.oneOf as Record<string, unknown>[];
    const properties: Record<string, unknown> = {};
    for (const branch of branches) {
      for (const [key, value] of Object.entries(branch.properties as Record<string, unknown> ?? {})) {
        if (properties[key] === undefined) properties[key] = value;
        else if (JSON.stringify(properties[key]) !== JSON.stringify(value)) {
          const previous = properties[key] as Record<string, unknown>;
          const next = value as Record<string, unknown>;
          const previousValues = Object.hasOwn(previous,'const') ? [previous.const] : previous.enum;
          const nextValues = Object.hasOwn(next,'const') ? [next.const] : next.enum;
          if (Array.isArray(previousValues) && Array.isArray(nextValues)) properties[key] = { enum: [...new Set([...previousValues,...nextValues])] };
          else properties[key] = { anyOf: [previous,next] };
        }
      }
    }
    schema.properties = properties;
    schema.required = Object.keys(properties).filter(key => branches.every(b => Array.isArray(b.required) && b.required.includes(key)));
  }
  explicitLiteralTypes(schema);
  return { name: entry.name, description: entry.description, inputSchema: schema };
}
export function mcpToolArguments(entry: typeof mcpToolEntries[number], input: unknown) { return parseToolArguments(entry.source, entry.variant, input); }
