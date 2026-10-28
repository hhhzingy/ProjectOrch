/** 拒绝空值/NaN、使用nearest-rank分位数；业务拒绝独立保留，不隐藏系统错误。 */
export function percentile(values,q){
 if(!Array.isArray(values)||!values.length||!values.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)||typeof q!=='number'||!Number.isFinite(q)||q<=0||q>1)throw Error('INVALID_PERFORMANCE_SAMPLES');
 return [...values].sort((a,b)=>a-b)[Math.ceil(q*values.length)-1];
}
export function summarizeRequests(samples,wallMs){
 if(!Number.isFinite(wallMs)||wallMs<=0||!Array.isArray(samples)||!samples.length)throw Error('INVALID_PERFORMANCE_WINDOW');
 const errors=samples.filter(s=>s.status!==200&&s.status!==201&&s.status!==202);
 return {requests:samples.length,reads:samples.filter(s=>s.method==='GET').length,writes:samples.filter(s=>s.method==='POST').length,rate:samples.length*1000/wallMs,p95Ms:percentile(samples.map(s=>s.latencyMs),.95),errors:errors.length,errorRate:errors.length/samples.length};
}
