import {api,ApiError} from '../api.js';

/** 明确手动刷新；只读官方历史，正文仅textContent。迟到响应不能跨项目/角色填充。 */
export async function mountConversation(root:HTMLElement,projectId:string,roleId:string,isCurrent:()=>boolean):Promise<void>{
 const doc=root.ownerDocument,make=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const node=doc.createElement(tag);node.textContent=text;return node;};
 const heading=make('h3','原生对话（只读）'),note=make('p','仅显示本角色当前绑定会话的用户/助手正文；不含内部推理、工具参数。刷新不会发送模型输入。'),status=make('p'),items=make('div'),refresh=make('button','刷新对话'),more=make('button','加载后续记录');
 refresh.type=more.type='button';more.hidden=true;status.setAttribute?.('role','status');root.append(heading,note,status,refresh,items,more);
 let cursor:string|null=null,busy=false;
 const load=async(reset:boolean)=>{
  if(busy||!isCurrent())return;busy=true;refresh.disabled=more.disabled=true;status.textContent='正在读取官方历史…';
  try{
   const page=await api.conversation(projectId,roleId,reset?null:cursor);if(!isCurrent())return;
   if(reset)items.replaceChildren();
   for(const item of page.items){const article=make('article'),label=make('strong',item.role==='user'?'用户 / 角色输入':'助手回复'),body=make('pre',item.text);article.append(label,body);items.append(article);}
   cursor=page.nextCursor;more.hidden=cursor===null;
   status.textContent=page.status==='unbound'?'尚未绑定原生会话，暂无对话。':`${page.harnessId??''} 官方历史已读取。${page.items.length===0?'暂无可显示正文。':''}${page.limited?'显示有上限，完整记录请到原生Harness查看。':''}新消息请手动刷新。`;
  }catch(error){if(!isCurrent())return;status.textContent=error instanceof ApiError&&error.message==='CONVERSATION_REFRESH_REQUIRED'?'分页快照已过期或绑定已变更，请刷新对话。':error instanceof ApiError&&error.message==='CONVERSATION_READER_NOT_CONFIGURED'?'尚未配置官方历史读取，请按启动说明配置Harness。':'暂时无法读取官方历史，请检查Harness配置和连接后刷新；已显示记录保留。';}
  finally{busy=false;if(isCurrent())refresh.disabled=more.disabled=false;}
 };
 refresh.onclick=()=>{void load(true);};more.onclick=()=>{void load(false);};await load(true);
}
