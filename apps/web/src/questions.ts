import {api} from './api.js';

/** 用户可发现的业务答复；项目代次隔离，正文只作文本，不把业务答复当原生审批。 */
export function questionPanel(doc:Document,projectId:string,current:()=>boolean,notify:(text:string)=>void){
 const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const n=doc.createElement(tag);n.textContent=text;return n;};
 const root=node('section'),heading=node('h3','待我答复的问题'),status=node('p','正在读取…'),list=node('div'),refresh=node('button','刷新待答问题'),more=node('button','加载更多问题');
 refresh.type=more.type='button';status.setAttribute('role','status');more.hidden=true;
 root.append(heading,node('p','这是指定给用户的业务问题。答复不会提高角色权限、解除暂停或批准原生操作。'),status,refresh,list,more);
 let cursor:string|null=null,loading=false;
 const append=(q:Awaited<ReturnType<typeof api.questions>>['items'][number])=>{
  const form=node('form'),title=node('h4',`任务 ${q.taskId}`),prompt=node('p',q.prompt),due=node('p','答复期限：'+q.deadline),answer=node('textarea'),label=node('label','你的答复'),button=node('button','提交业务答复'),result=node('p');
  answer.maxLength=16384;answer.required=true;answer.setAttribute('aria-label','你的答复');label.append(answer);button.type='submit';result.setAttribute('role','status');form.append(title,prompt,due,label,button,result);list.append(form);
  let requestId:string|null=null,submittedText:string|null=null,busy=false;
  form.addEventListener('submit',event=>{
   event.preventDefault();if(busy||!current()||!answer.value.trim())return;
   if(submittedText!==answer.value){requestId=crypto.randomUUID();submittedText=answer.value;}
   busy=true;button.disabled=true;answer.disabled=true;
   void api.answerQuestion({schemaVersion:2,requestId,projectId,type:'question.answer',payload:{questionId:q.id,expectedRevision:q.revision,answer:submittedText}}).then(receipt=>{
    if(receipt.status!=='completed')throw Error('ANSWER_NOT_COMPLETED');
    if(!current())return;result.textContent='答复已保存，后续执行仍需通过当前准入。';button.hidden=true;notify('业务答复已保存。');
   }).catch(()=>{if(current()){result.textContent='尚未确认保存。可重试原答复；如问题已过期或被回答，请刷新核对。草稿已保留。';button.disabled=false;answer.disabled=false;}}).finally(()=>{busy=false;});
  });
 };
 const load=async(reset:boolean)=>{
  if(loading||!current())return;loading=true;refresh.disabled=true;more.disabled=true;
  try{const page=await api.questions(projectId,reset?null:cursor);if(!current())return;if(reset)list.replaceChildren();for(const q of page.items)append(q);cursor=page.nextCursor;more.hidden=cursor===null;status.textContent=(list.childElementCount?'已加载 '+list.childElementCount+' 个待答问题。':'当前没有待你答复的问题。')+(page.legacyCount?'另有 '+page.legacyCount+' 条旧记录需要诊断修复。':'');}
  catch{if(current())status.textContent='问题列表读取失败或分页已变化，请刷新重试；现有草稿保留。';}
  finally{loading=false;refresh.disabled=false;more.disabled=false;}
 };
 refresh.onclick=()=>{if(list.querySelector('textarea')&&Array.from(list.querySelectorAll('textarea')).some(t=>t.value.trim()&&!t.disabled)){status.textContent='存在未提交草稿，请先提交或清空后再刷新。';return;}void load(true);};
 more.onclick=()=>{void load(false);};void load(true);return root;
}
