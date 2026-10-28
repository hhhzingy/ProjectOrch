/** 合成旧/新客户端对固定服务合同的独立进程接口；不连接Harness或执行业务。 */
import { ContractError, negotiateAdapter, parseContract } from '../../packages/contracts/dist/index.js';
process.on('message', frame => {
  try {
    const negotiated = negotiateAdapter(frame.versions, frame.hello, frame.requiredCapabilities);
    const message = parseContract('message', frame.message);
    process.send({ id: frame.id, status: 'accepted', schemaVersion: negotiated.schemaVersion, requestId: message.requestId });
  } catch (error) {
    process.send({ id: frame.id, status: 'rejected', code: error instanceof ContractError ? error.code : 'INTERNAL_ERROR', reason: error instanceof ContractError ? error.reason : 'UNEXPECTED_ERROR' });
  }
});
process.on('disconnect', () => process.exit(0));
