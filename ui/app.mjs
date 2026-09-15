const $=id=>document.getElementById(id);
const editable=['provider','model','effort','enabled','execution','access','permissions','read_mode'];
const budgetKeys=['max_model_turns','max_tool_calls','max_output_tokens','max_provider_calls','max_duration_seconds','max_read_bytes','max_total_read_bytes'];
const fieldNames={provider:'CLI',model:'模型',effort:'推理档位',enabled:'启用状态',execution:'执行位置',access:'写入能力',permissions:'权限策略',models:'模型允许列表',roles:'路由角色',escalate_after:'升级失败阈值',max_delegations:'单个工作包委派上限'};
Object.assign(fieldNames,{budget:'执行预算',read_mode:'读取方式'});
const fragment=new URLSearchParams(location.hash.slice(1)),linkToken=fragment.get('token');
let token=linkToken;
try{if(linkToken)sessionStorage.setItem('aw-ui-token',linkToken);else token=sessionStorage.getItem('aw-ui-token');}catch{/* The complete link still works when browser storage is unavailable. */}
if(linkToken)history.replaceState(null,'',location.pathname);
let snapshot=null,selected=null,busy=false,conflict=false,previewRequest=null,routingDraft=null;
const drafts=new Map(),catalogs=new Map(),discovering=new Set();
function element(tag,content,className){const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;}
function notice(message,success=false){$('notice').textContent=message;$('notice').hidden=!message;$('notice').classList.toggle('success',success);}
async function api(route,body){
  const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token??''}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.message??'请求失败');error.code=result.error;throw error;}
  return result;
}
function errorText(error){return error.name==='TimeoutError'?'本地服务响应超时，请稍后重试。':error instanceof TypeError?'无法连接本地服务，请确认 aw ui 仍在运行。':error.message;}
function handleError(error){if(error.code==='config_conflict'){conflict=true;updateActions();}notice(errorText(error));}
function currentRole(){return snapshot.roles.find(r=>r.id===selected);}
function binding(role){return drafts.get(role.id)??role.binding;}
function changes(){return [...drafts].map(([role,next])=>({role,allow_model:next.allow_model===true,patch:Object.fromEntries([...editable,'budget'].filter(key=>JSON.stringify(next[key])!==JSON.stringify(snapshot.roles.find(r=>r.id===role).binding[key])).map(key=>[key,next[key]]))}));}
function displayValue(field,value){if(typeof value==='object'&&value!==null)return JSON.stringify(value);if(field==='permissions')return value==='full-access'?'完整权限（主机与网络访问）':'受限权限';if(field==='access')return value==='workspace-write'?'可修改文件':'只读';if(value===null||value==='')return '不指定';if(field==='enabled')return value?'启用':'停用';if(field==='execution')return value==='host'?'当前主对话':'独立辅助任务';return String(value);}
function renderRoles(){
  $('roles').replaceChildren(...[...snapshot.roles].sort((a,b)=>Number(binding(a).execution==='host')-Number(binding(b).execution==='host')).map(role=>{
    const b=binding(role),button=element('button',undefined,'role-button');button.type='button';button.dataset.role=role.id;button.setAttribute('aria-current',String(role.id===selected));
    button.append(element('strong',role.label),element('span',drafts.has(role.id)?'待保存':b.enabled?(b.execution==='host'?'主对话':'辅助'):'停用',`role-indicator${drafts.has(role.id)?' changed':''}`),element('small',b.execution==='host'?'使用当前会话，无需配置模型':b.model?`${b.model} · ${b.effort??'默认'}`:'尚未绑定模型'));
    button.addEventListener('click',()=>{selected=role.id;renderRoles();renderEditor();});return button;
  }));
}
function selectedModels(){
  const provider=snapshot.providers.find(p=>p.id===$('provider').value);
  return {provider,models:catalogs.get(provider?.id)?.models??provider?.models??[]};
}
function renderModelChoices(){
  const {provider,models}=selectedModels();
  $('model-options').replaceChildren(...models.map(m=>{const option=element('option');option.value=m.id;option.label=m.allowed===false?'需加入允许列表':m.verified?'CLI 目录':'主机配置';return option;}));
  renderEfforts();
  const catalog=catalogs.get(provider?.id);
  const source=provider?.has_allowlist?'可手动输入模型与档位；勾选下方选项可将其加入此 CLI 的允许列表。':'可选择目录中的模型；实际可用性会在任务启动时检查。';
  $('model-help').textContent=discovering.has(provider?.id)?'正在读取 CLI 模型目录，不运行分析任务…':catalog?.error?`目录未能确认（${catalog.error}）。${source}`:catalog?`目录已读取；标注来自 CLI 或主机配置，不代表任务验证通过。${source}`:`当前显示主机配置。${source}`;
  $('refresh-models').disabled=busy||!provider||discovering.has(provider.id);
}
function renderEfforts(){
  const {provider,models}=selectedModels(),id=$('model').value;
  const configured=provider?.models.find(m=>m.id===id),found=models.find(m=>m.id===id);
  const efforts=[...new Set([...(configured?.efforts??[]),...(found?.efforts??[])])];
  $('effort-options').replaceChildren(...efforts.map(e=>{const option=element('option');option.value=e;return option;}));
}
function renderExecution(){
  const writable=$('access').value==='workspace-write',host=$('execution').value==='host',full=$('permissions').value==='full-access';
  document.querySelectorAll('[data-worker-field]').forEach(node=>{node.hidden=host;});
  $('provider').required=!host;
  $('access').options[1].disabled=currentRole().access!=='workspace-write';
  $('permissions').disabled=!writable;
  $('read_mode').options[1].disabled=writable;
  if(writable&&$('read_mode').value==='evidence')$('read_mode').value='';
  $('execution-note').textContent=host?'职责由当前 Codex 会话承担，无需绑定外部 CLI、模型或档位。建议保持基础和主力开发在主入口，只为升级与专项角色配置外部模型。':writable?(full?'完整权限：worker 可读写文件、运行命令并访问主机与网络。独立工作区不提供系统隔离；AW 仍校验交付范围并运行验收命令。':'受限权限：worker 修改指定范围的文件，AW 执行声明的测试并续接修复。Codex 使用原生工作区沙箱；其他 CLI 使用文件工具权限。'):'独立只读任务，交付分析、方案或审查结果。';
}
function renderEditor(){
  const role=currentRole(),b=binding(role);
  $('role-id').textContent=role.id;$('role-title').textContent=role.label;$('role-description').textContent=role.description;
  $('provider').replaceChildren(element('option','请选择 CLI'),...snapshot.providers.map(p=>{const option=element('option',`${p.id} · ${p.adapter}`);option.value=p.id;return option;}));
  $('provider').options[0].value='';
  for(const key of editable){if(key==='enabled')$(key).checked=b[key];else $(key).value=b[key]??'';}
  for(const key of budgetKeys)$(key).value=b.budget?.[key]??snapshot.budget[key];
  $('allow-model').checked=b.allow_model===true;
  $('role-state').textContent=b.enabled?'已启用':'已停用';$('role-state').classList.toggle('off',!b.enabled);
  $('instructions').textContent=role.instructions;renderModelChoices();renderExecution();updateActions();
}
function updateActions(){
  const dirty=drafts.size>0||routingDraft!==null;
  $('preview').disabled=!dirty||busy||conflict;$('reload').disabled=busy;$('binding-fields').disabled=busy;
  $('refresh-models').disabled=busy||!$('provider').value||discovering.has($('provider').value);
  $('automatic-routing').disabled=busy||!snapshot;
  $('save-status').textContent=conflict?'配置文件已有新版本':dirty?`${drafts.size} 个角色${routingDraft!==null?'及调度设置':''}有未保存修改`:'与配置文件一致';
  $('save-detail').textContent=conflict?'草稿已保留，请重新读取后再编辑。':'已有任务保持创建时的模型与档位。';
  $('save-dot').classList.toggle('dirty',dirty||conflict);
  $('save').disabled=busy||conflict;$('cancel-preview').disabled=busy;
}
function acceptSnapshot(next){
  snapshot=next;routingDraft=null;$('automatic-routing').checked=next.routing.enabled;drafts.clear();catalogs.clear();conflict=false;selected=next.roles.some(r=>r.id===selected)?selected:next.roles.find(r=>r.binding.execution==='worker')?.id??next.roles[0]?.id;
  $('host-name').textContent=next.host_id;$('host-file').textContent=next.host_config;
  $('role-count').textContent=`${next.roles.length} 个角色 · ${next.providers.length} 个 CLI`;$('roster-count').textContent=String(next.roles.length).padStart(2,'0');
  $('workspace').hidden=!selected;$('save-bar').hidden=!selected;$('file-details').hidden=false;
  renderRoles();if(selected)renderEditor();
}
function edit(){
  const role=currentRole(),next=Object.fromEntries(editable.map(key=>[key,key==='enabled'?$(key).checked:['effort','read_mode'].includes(key)?($(key).value||null):$(key).value]));
  next.budget={...role.binding.budget};
  for(const key of budgetKeys){const value=Number($(key).value);if(value!==(role.binding.budget?.[key]??snapshot.budget[key]))next.budget[key]=value;}
  next.allow_model=$('allow-model').checked;
  if(next.allow_model||[...editable,'budget'].some(key=>JSON.stringify(next[key])!==JSON.stringify(role.binding[key])))drafts.set(role.id,next);else drafts.delete(role.id);
  $('role-state').textContent=next.enabled?'已启用':'已停用';$('role-state').classList.toggle('off',!next.enabled);renderRoles();updateActions();
}
for(const key of editable)$(key).addEventListener(key==='model'||key==='effort'?'input':'change',()=>{
  if(key==='provider'){$('model').value='';$('effort').value='';renderModelChoices();}
  if(key==='model')renderEfforts();if(key==='access'&&$('access').value==='read-only')$('permissions').value='restricted';renderExecution();edit();
});
$('allow-model').addEventListener('change',edit);
for(const key of budgetKeys)$(key).addEventListener('input',edit);
$('automatic-routing').addEventListener('change',()=>{routingDraft=$('automatic-routing').checked===snapshot.routing.enabled?null:$('automatic-routing').checked;updateActions();});
$('binding-form').addEventListener('submit',e=>e.preventDefault());
$('refresh-models').addEventListener('click',async()=>{
  const provider=$('provider').value,revision=snapshot.revision;discovering.add(provider);renderModelChoices();
  try{const result=await api(`/api/models?provider=${encodeURIComponent(provider)}&refresh=1`);if(snapshot.revision===revision)catalogs.set(provider,result);}catch(error){handleError(error);}finally{discovering.delete(provider);renderModelChoices();}
});
$('reload').addEventListener('click',async()=>{
  if((drafts.size||routingDraft!==null)&&!window.confirm('重新读取将丢弃尚未保存的草稿，继续吗？'))return;
  busy=true;updateActions();try{acceptSnapshot(await api('/api/config'));notice('已重新读取配置。',true);}catch(error){handleError(error);}finally{busy=false;updateActions();}
});
$('preview').addEventListener('click',async()=>{
  busy=true;updateActions();previewRequest={revision:snapshot.revision,changes:changes(),...(routingDraft!==null?{routing:{enabled:routingDraft}}:{})};
  try{
    const result=await api('/api/preview',previewRequest),groups=new Map();
    for(const change of result.changes){
      if(!groups.has(change.role)){const group=element('section',undefined,'preview-group');group.append(element('h3',change.label));groups.set(change.role,group);}
      const row=element('div',undefined,'change-row');row.append(element('span',fieldNames[change.field]),element('code',displayValue(change.field,change.before),'old-value'),element('span','→'),element('code',displayValue(change.field,change.after),'new-value'));groups.get(change.role).append(row);
    }
    $('preview-list').replaceChildren(...groups.values());$('dialog-error').hidden=true;$('preview-dialog').showModal();
  }catch(error){handleError(error);}finally{busy=false;updateActions();}
});
$('cancel-preview').addEventListener('click',()=>$('preview-dialog').close());
$('preview-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('save').addEventListener('click',async()=>{
  if(!previewRequest||conflict||busy)return;busy=true;updateActions();$('save').textContent='正在保存…';
  try{acceptSnapshot(await api('/api/config',previewRequest));$('preview-dialog').close();notice('配置已保存。新建辅助任务将读取更新后的角色绑定。',true);previewRequest=null;}
  catch(error){if(error.code==='config_conflict')conflict=true;$('dialog-error').textContent=errorText(error);$('dialog-error').hidden=false;}
  finally{busy=false;$('save').textContent='保存配置';updateActions();}
});
window.addEventListener('beforeunload',event=>{if(drafts.size||routingDraft!==null){event.preventDefault();event.returnValue='';}});
let checking=false;
async function checkExternalChanges(){
  if(!snapshot||busy||checking||document.hidden||$('preview-dialog').open)return;checking=true;
  const revision=snapshot.revision;
  try{const next=await api('/api/config');if(snapshot.revision!==revision||busy||$('preview-dialog').open)return;
    if(next.revision!==snapshot.revision){if(drafts.size||routingDraft!==null){conflict=true;notice('检测到配置文件变化。当前草稿保留在页面中，请重新读取后再编辑。');updateActions();}else{acceptSnapshot(next);notice('已自动读取最新配置。',true);}}
  }catch(error){handleError(error);}finally{checking=false;}
}
window.addEventListener('focus',checkExternalChanges);setInterval(checkExternalChanges,15000);
try{if(!token)throw new Error('请运行 aw ui，并使用命令显示的完整链接打开配置界面。');acceptSnapshot(await api('/api/config'));}catch(error){document.body.classList.add('initial-error');$('host-name').textContent='未连接';$('role-count').textContent='配置尚未读取';handleError(error);}
