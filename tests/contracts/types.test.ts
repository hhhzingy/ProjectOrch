import type { ContractRegistry } from "../../packages/contracts/src/index.js";

const message: ContractRegistry["message"] = {
  schemaVersion: 2,
  requestId: "synthetic-request",
  projectId: "synthetic-project",
  toRoleId: "synthetic-role",
  kind: "question",
  body: "synthetic",
  delivery: { mode: "when_available", priority: "normal" },
};

// @ts-expect-error 固定草案不接受 v1，即使对象其他字段一致。
const oldVersion: ContractRegistry["message"] = { ...message, schemaVersion: 1 };
// @ts-expect-error 正文必须为字符串。
const wrongBody: ContractRegistry["message"] = { ...message, body: 123 };
// @ts-expect-error 不允许自报管理员权限。
const inventedPrivilege: ContractRegistry["message"] = { ...message, admin: true };
// @ts-expect-error 空对象查询载荷不能误生成接受数字的 {} 类型。
const wrongQuery: ContractRegistry["query"] = { schemaVersion: 2, type: "identity", payload: 123 };
void oldVersion;
void wrongBody;
void inventedPrivilege;
void wrongQuery;

const receipt: ContractRegistry["receipt"] = { requestId: "synthetic", projectId: "synthetic-project", commandId: "synthetic-command", status: "completed", receiptUrl: "/synthetic-not-live", entityIds: [], error: null, lastEventSequence: 0 };
// @ts-expect-error 固定回执类型要求整数，不接受字符串。
const wrongSequence: ContractRegistry["receipt"] = { ...receipt, lastEventSequence: "0" };
void wrongSequence;
