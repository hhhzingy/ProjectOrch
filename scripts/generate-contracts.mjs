import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compile } from 'json-schema-to-typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'contracts/schemas');
const names = fs.readdirSync(dir).filter(n => n.endsWith('.schema.json')).sort();
const schemas = names.map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
const publicSchemas = schemas.filter(s => s.type || s.oneOf);
const nameOf = s => s.$id.split('/').at(-1).replace('.schema.json', '');
// 回执是已有固定领域定义；只导出具名入口，不接受调用者提供任意 $ref。
const entryRefs = { ...Object.fromEntries(publicSchemas.map(s => [nameOf(s), s.$id])), receipt: 'https://projectorch.invalid/schemas/domain.schema.json#/$defs/Receipt', policy: 'https://projectorch.invalid/schemas/domain.schema.json#/$defs/Policy', 'task-detail': 'https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskDetail', 'task-spec': 'https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskSpec' };
const registry = new Map(schemas.map(s => [s.$id, s]));
entryRefs.question='https://projectorch.invalid/schemas/domain.schema.json#/$defs/Question';
entryRefs.handover='https://projectorch.invalid/schemas/domain.schema.json#/$defs/Handover';
entryRefs.integration='https://projectorch.invalid/schemas/domain.schema.json#/$defs/Integration';
const fingerprint = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
const rootSchema = { type: 'object', title: 'ContractRegistry', additionalProperties: false, properties: Object.fromEntries(Object.entries(entryRefs).map(([name, id]) => [name, { $ref: id }])), required: Object.keys(entryRefs) };
const banner = `/** 由 scripts/generate-contracts.mjs 从固定 Schema 生成，勿手改。Schema SHA-256: ${fingerprint}。类型不替代运行时约束、授权或原生验收。 */`;
function typeSchema(value) {
  if (Array.isArray(value)) return value.map(typeSchema);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeSchema(v)]));
  if (copy.type === 'object' && copy.additionalProperties === false && !Object.keys(copy.properties ?? {}).length && !copy.$ref && !copy.oneOf && !copy.anyOf && !copy.allOf) copy.tsType = 'Record<string, never>';
  return copy;
}
const types = await compile(rootSchema, 'ContractRegistry', {
  bannerComment: banner,
  maxItems: -1,
  unreachableDefinitions: false,
  $refOptions: { resolve: {
    http: false,
    file: false,
    projectorch: { order: 1, canRead: file => registry.has(file.url), read: file => JSON.stringify(typeSchema(registry.get(file.url))) },
  } },
});
const snapshot = `${banner}\nexport const schemaFingerprint = ${JSON.stringify(fingerprint)};\nexport const schemaDocuments: readonly object[] = ${JSON.stringify(schemas, null, 2)};\nexport const schemaIds = ${JSON.stringify(entryRefs, null, 2)} as const;\n`;
for (const [rel, text] of [['packages/contracts/src/models.generated.ts', types], ['packages/contracts/src/schemas.generated.ts', snapshot]]) {
  const dest = path.join(root, rel);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== text) throw new Error(`生成合同已过期：${rel}`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text);
  }
}
process.stdout.write(`合同类型与 Schema 快照${process.argv.includes('--check') ? '一致' : '已生成'}：${fingerprint}\n`);
