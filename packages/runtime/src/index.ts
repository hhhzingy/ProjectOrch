/** 工程启动检查，不代表原生适配能力已验证。 */
export function assertSupportedNode(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 24 || Number(match[2]) < 14) {
    throw new Error(`不支持的 Node.js 运行时：${version}；开发最低 24.14.0，锁定目标 24.22.0。`);
  }
}

export const applicationInfo = Object.freeze({
  name: "ProjectOrch",
  version: "0.1.0-dev.0",
  contractVersion: 2,
  stage: "engineering-bootstrap",
  nativeIntegration: "NOT_VERIFIED",
});
