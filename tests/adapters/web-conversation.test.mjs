import test from 'node:test';import assert from 'node:assert/strict';
import {mountConversation} from '../../apps/web/dist/roles/conversation.js';
function dom(){const document={createElement:tag=>({tagName:tag,textContent:'',children:[],ownerDocument:document,append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;}})};return document.createElement('section');}
test('正文面板分页/手动刷新使用原游标，正文仅文本；失败保留已读记录',async()=>{
 const root=dom(),original=globalThis.fetch,urls=[];let fail=false;
 globalThis.fetch=async url=>{urls.push(String(url));if(fail)throw Error('offline');return{ok:true,json:async()=>({status:'observed',harnessId:'codex',items:[{id:'x',role:'assistant',text:'<script>不执行</script>'}],nextCursor:urls.length===1?'snapshot:30':null,limited:false})};};
 try{await mountConversation(root,'p','r',()=>true);const [,,status,refresh,items,more]=root.children;assert.equal(items.children[0].children[1].textContent,'<script>不执行</script>');assert.equal(more.hidden,false);more.onclick();await new Promise(r=>setImmediate(r));assert.match(urls[1],/cursor=snapshot%3A30/);assert.equal(items.children.length,2);fail=true;refresh.onclick();await new Promise(r=>setImmediate(r));assert.match(status.textContent,/已显示记录保留/);assert.equal(items.children.length,2);}finally{globalThis.fetch=original;}
});
test('切换角色后迟到正文不进入旧面板',async()=>{
 const root=dom(),original=globalThis.fetch;let release,current=true;const pending=new Promise(r=>release=r);
 globalThis.fetch=async()=>{await pending;return{ok:true,json:async()=>({status:'observed',items:[{id:'old',role:'user',text:'OLD_BODY'}],nextCursor:null,limited:false})};};
 try{const loading=mountConversation(root,'p','old',()=>current);current=false;release();await loading;assert.equal(root.children[4].children.length,0);}finally{globalThis.fetch=original;}
});
