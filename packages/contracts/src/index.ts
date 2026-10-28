import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats = require("ajv-formats");
import type { ContractRegistry } from "./models.generated.js";
import { schemaDocuments, schemaIds } from "./schemas.generated.js";

export type * from "./models.generated.js";
export { schemaFingerprint } from "./schemas.generated.js";
export type ContractName = keyof typeof schemaIds;

export class ContractError extends Error {
  readonly code: "VALIDATION_ERROR" | "CAPABILITY_UNSUPPORTED";
  readonly reason: string;
  readonly issues: readonly { instancePath: string; keyword: string; schemaPath: string; field?:string }[];
  constructor(reason: string, issues: readonly { instancePath: string; keyword: string; schemaPath: string;field?:string }[] = [], code: "VALIDATION_ERROR" | "CAPABILITY_UNSUPPORTED" = "VALIDATION_ERROR") {
    super(`协议校验失败：${reason}`);
    this.name = "ContractError";
    this.code = code;
    this.reason = reason;
    this.issues = issues.slice(0, 16);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true, ownProperties: true });
addFormats.default(ajv);
for (const schema of schemaDocuments) ajv.addSchema(schema);
const validators = new Map(Object.entries(schemaIds).map(([name, id]) => [name, ajv.getSchema(id)]));

/** 只使用发布件内固定 Schema；输入不可提供 Schema、SQL 或可信身份。 */
export function parseContract<K extends ContractName>(name: K, input: unknown): ContractRegistry[K] {
  if (!Object.hasOwn(schemaIds, name)) throw new ContractError("UNKNOWN_CONTRACT");
  let data: unknown;
  try { data = structuredClone(input); } catch { throw new ContractError("NON_JSON_INPUT"); }
  if (data && typeof data === "object" && Object.hasOwn(data, "schemaVersion") && (data as { schemaVersion: unknown }).schemaVersion !== 2) {
    throw new ContractError("UNSUPPORTED_PROTOCOL_VERSION");
  }
  const validate = validators.get(name);
  if (!validate?.(data)) throw new ContractError("SCHEMA_MISMATCH", (validate?.errors ?? []).map(({ instancePath, keyword, schemaPath }) => ({ instancePath, keyword, schemaPath })));
  return data as ContractRegistry[K];
}

export function parseContractJson<K extends ContractName>(name: K, json: string): ContractRegistry[K] {
  if (typeof json !== "string") throw new ContractError("INVALID_JSON");
  if (Buffer.byteLength(json, "utf8") > 1024 * 1024) throw new ContractError("INPUT_TOO_LARGE");
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new ContractError("INVALID_JSON"); }
  return parseContract(name, data);
}

/** 草案 v2 不静默降级到 v1，也不因客户端声称新版本而执行未知协议。 */
export function negotiateProtocol(clientVersions: unknown): 2 {
  if (!Array.isArray(clientVersions) || !clientVersions.length || clientVersions.length > 16 || clientVersions.some(v => !Number.isSafeInteger(v) || v < 1)) throw new ContractError("INVALID_VERSION_OFFER");
  if (!clientVersions.includes(2)) throw new ContractError("UNSUPPORTED_PROTOCOL_VERSION");
  return 2;
}

/** 仅协商适配器声明；真实能力证据、主机身份和授权须由绑定/准入服务核验。 */
export function negotiateAdapter(clientVersions: unknown, hello: unknown, requiredCapabilities: readonly string[]): { schemaVersion: 2; declaration: ContractRegistry["capabilities"] } {
  const schemaVersion = negotiateProtocol(clientVersions);
  const declaration = parseContract("capabilities", hello);
  for (const name of requiredCapabilities) {
    if (!Object.hasOwn(declaration.capabilities, name)) throw new ContractError("UNKNOWN_CAPABILITY", [], "CAPABILITY_UNSUPPORTED");
    const capability = declaration.capabilities[name as keyof typeof declaration.capabilities];
    if (capability.state !== "verified") throw new ContractError("CAPABILITY_NOT_VERIFIED", [], "CAPABILITY_UNSUPPORTED");
  }
  return { schemaVersion, declaration };
}

type ToolSchemaSource = "command" | "query" | "message" | "result" | "changeset" | "project-create";
type JsonSchema = Record<string, unknown>;
const toolSchemas = new Map<string, JsonSchema>();
const toolValidators = new Map<string, ReturnType<typeof ajv.compile>>();
/** 从内置合同生成工具参数，不允许模型提供Schema或让MCP客户端联网解析内部$ref。 */
export function toolArgumentSchema(source: ToolSchemaSource, variant = ""): JsonSchema {
  if (!["command", "query", "message", "result", "changeset", "project-create"].includes(source)) throw new ContractError("UNKNOWN_TOOL_SCHEMA");
  const key = `${source}:${variant}`; const cached = toolSchemas.get(key); if (cached) return structuredClone(cached);
  const documents = new Map(schemaDocuments.map(value => { const schema = value as JsonSchema; return [String(schema.$id), schema] as const; }));
  const document = documents.get(schemaIds[source]); if (!document) throw new ContractError("UNKNOWN_TOOL_SCHEMA");
  const object = (value: unknown): JsonSchema => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("INVALID_TOOL_SCHEMA"); return value as JsonSchema; };
  let nodes = 0;
  const expand = (value: unknown, base: JsonSchema, seen = new Set<string>(), depth = 0): unknown => {
    if (++nodes > 50000 || depth > 64) throw new ContractError("TOOL_SCHEMA_TOO_COMPLEX");
    if (Array.isArray(value)) return value.map(item => expand(item, base, seen, depth + 1));
    if (!value || typeof value !== "object") return value;
    const entry = value as JsonSchema;
    if (typeof entry.$ref === "string") {
      const url = new URL(entry.$ref, String(base.$id)); const reference = url.href;
      if (seen.has(reference)) throw new ContractError("RECURSIVE_TOOL_SCHEMA");
      const target = documents.get(reference.split("#")[0] ?? ""); if (!target) throw new ContractError("EXTERNAL_TOOL_SCHEMA_FORBIDDEN");
      let pointed: unknown = target;
      for (const part of decodeURIComponent(url.hash.slice(1)).split("/").slice(1)) pointed = object(pointed)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (pointed === undefined) throw new ContractError("UNKNOWN_TOOL_SCHEMA_REFERENCE");
      const next = new Set(seen); next.add(reference);
      const resolved = expand(pointed, target, next, depth + 1); const siblings = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "$ref"));
      return Object.keys(siblings).length ? { allOf: [resolved, expand(siblings, base, seen, depth + 1)] } : resolved;
    }
    return Object.fromEntries(Object.entries(entry).filter(([k]) => !["$id", "$schema", "$defs"].includes(k)).map(([k, v]) => [k, expand(v, base, seen, depth + 1)]));
  };
  let schema: JsonSchema;
  if (source === "command" || source === "query") {
    const branch = (document.oneOf as JsonSchema[]).find(v => object(object(v.properties).type).const === variant);
    if (!branch) throw new ContractError("UNKNOWN_TOOL_VARIANT");
    const payload = object(expand(object(branch.properties).payload, document));
    const withRequest = (part: JsonSchema): JsonSchema => {
      if (Array.isArray(part.oneOf)) return { type: "object", oneOf: part.oneOf.map(value => withRequest(object(value))) };
      return { ...part, properties: { requestId: { type: "string", minLength: 1, maxLength: 128 }, ...object(part.properties) }, required: ["requestId", ...(part.required as string[] ?? [])] };
    };
    schema = source === "query" ? payload : withRequest(payload);
  } else {
    schema = object(expand(document, document));
    schema.properties = Object.fromEntries(Object.entries(object(schema.properties)).filter(([k]) => !["schemaVersion", "projectId"].includes(k)));
    schema.required = (schema.required as string[]).filter(k => !["schemaVersion", "projectId"].includes(k));
  }
  toolSchemas.set(key, structuredClone(schema)); return structuredClone(schema);
}
export function parseToolArguments(source: ToolSchemaSource, variant: string, input: unknown): Record<string, unknown> {
  const key = `${source}:${variant}`;
  let validator = toolValidators.get(key);
  if (!validator) { validator = ajv.compile(toolArgumentSchema(source, variant)); toolValidators.set(key, validator); }
  const data: unknown = structuredClone(input);
  if (!validator(data)) {
    let errors=[...(validator.errors??[])];
    // 聚焦实际操作分支，避免把role.create的缺name淹没在所有oneOf不匹配错误中。
    if(source==='changeset'&&data&&typeof data==='object'&&'operations' in data&&Array.isArray(data.operations)){
      const schema=toolArgumentSchema(source,variant),properties=schema.properties as Record<string,JsonSchema>|undefined,branches=((properties?.operations?.items as JsonSchema|undefined)?.oneOf??[]) as JsonSchema[];
      for(const [index,operation]of data.operations.entries()){
        if(!operation||typeof operation!=='object'||typeof operation.type!=='string')continue;
        const branch=branches.find(b=>(b.properties as Record<string,JsonSchema>|undefined)?.type?.const===operation.type);if(!branch)continue;
        const prefix=`/operations/${index}`;errors=errors.filter(e=>e.instancePath!==prefix&&!e.instancePath.startsWith(prefix+'/'));
        const branchKey=`operation:${operation.type}`;let check=toolValidators.get(branchKey);if(!check){check=ajv.compile(branch);toolValidators.set(branchKey,check);}if(!check(operation))errors.push(...(check.errors??[]).map(e=>({...e,instancePath:`/operations/${index}${e.instancePath}`})));
      }
    }
    throw new ContractError('TOOL_ARGUMENTS_INVALID',errors.map(e=>({instancePath:e.instancePath.slice(0,256),keyword:e.keyword,schemaPath:e.schemaPath,...(typeof (e.params.missingProperty??e.params.additionalProperty)==='string'?{field:String(e.params.missingProperty??e.params.additionalProperty).slice(0,128)}:{})})));
  }
  return data as Record<string, unknown>;
}
