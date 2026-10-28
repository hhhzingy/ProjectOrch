import assert from 'node:assert/strict';
import test from 'node:test';
import {percentile,summarizeRequests} from '../performance/metrics.mjs';
test('性能指标拒绝null/NaN/空样本，不把缺堆内存采样计为成功',()=>{
 for(const values of [[],[null],[NaN],[Infinity],[-1]])assert.throws(()=>percentile(values,.95));
 assert.equal(percentile(Array.from({length:100},(_,i)=>100-i),.95),95);
});
test('实际吞吐按墙钟而非请求目标计算，混合读写的拒绝及系统错误不被吞掉',()=>{
 const result=summarizeRequests([{method:'GET',status:200,latencyMs:1},{method:'POST',status:202,latencyMs:2},{method:'POST',status:409,latencyMs:3},{method:'GET',status:500,latencyMs:4}],2000);
 assert.deepEqual(result,{requests:4,reads:2,writes:2,rate:2,p95Ms:4,errors:2,errorRate:.5});
});
