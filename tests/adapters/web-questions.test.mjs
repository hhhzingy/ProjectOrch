import test from 'node:test';
import assert from 'node:assert/strict';
import {questionPanel} from '../../apps/web/dist/questions.js';

function document(){const doc={createElement(tag){return {tagName:tag,ownerDocument:doc,textContent:'',children:[],listeners:{},value:'',disabled:false,hidden:false,setAttribute(){},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},get childElementCount(){return this.children.length;},addEventListener(name,fn){this.listeners[name]=fn;},querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...child.querySelectorAll(tag)]);},querySelector(tag){return this.querySelectorAll(tag)[0]??null;}};}};return doc;}
const tick=()=>new Promise(r=>setImmediate(r));
const question={id:'q',taskId:'task',revision:0,prompt:'<script>问题仅作文字</script>',deadline:'2026-10-27T18:00:00Z'};

test('用户问题组件：可发现、按原版本提交、网络失败保留草稿和幂等请求；不把答复当原生审批',async()=>{
 const original=globalThis.fetch,posts=[];let failed=true;globalThis.fetch=async(url,options={})=>{
  if(String(url).endsWith('/questions'))return {ok:true,json:async()=>({items:[question],nextCursor:null,legacyCount:0})};
  if(String(url).endsWith('/session/csrf'))return {ok:true,json:async()=>({csrfToken:'synthetic'})};
  posts.push(JSON.parse(options.body));if(failed){failed=false;throw Error('network');}return {ok:true,json:async()=>({status:'completed'})};
 };
 try{
  const panel=questionPanel(document(),'p',()=>true,()=>{});await tick();assert.equal(panel.children[0].textContent,'待我答复的问题');
  const answer=panel.querySelector('textarea'),form=panel.querySelector('form');answer.value='采用B';form.listeners.submit({preventDefault(){}});await tick();assert.equal(answer.value,'采用B');assert.equal(answer.disabled,false);
  form.listeners.submit({preventDefault(){}});await tick();assert.equal(posts.length,2);assert.equal(posts[0].requestId,posts[1].requestId);assert.deepEqual(posts[1].payload,{questionId:'q',expectedRevision:0,answer:'采用B'});assert.equal(answer.disabled,true);
  assert.equal(form.children.find(e=>e.tagName==='p').textContent,question.prompt,'模型正文不作为HTML渲染');
 }finally{globalThis.fetch=original;}
});

test('用户问题组件：项目切换后的迟到响应不能显示旧问题；刷新不丢未提交草稿',async()=>{
 const original=globalThis.fetch;let resolve,current=true;globalThis.fetch=()=>new Promise(r=>{resolve=r;});
 try{
  const panel=questionPanel(document(),'p',()=>current,()=>{});current=false;resolve({ok:true,json:async()=>({items:[question],nextCursor:null,legacyCount:0})});await tick();assert.equal(panel.querySelector('form'),null);
  current=true;globalThis.fetch=async()=>({ok:true,json:async()=>({items:[question],nextCursor:null,legacyCount:0})});const next=questionPanel(document(),'p',()=>current,()=>{});await tick();next.querySelector('textarea').value='未提交';const refresh=next.children.find(e=>e.tagName==='button');refresh.onclick();assert.equal(next.querySelector('textarea').value,'未提交');assert.match(next.children[2].textContent,/未提交草稿/);
 }finally{globalThis.fetch=original;}
});
