import fs from 'node:fs';
import path from 'node:path';
import {id,readJson,atomicJson,hash,requireValue,processIdentity,sameProcess,sleep,integer,within,real} from './core.mjs';
import {resolveRole} from './config.mjs';
import {prepareRequest,buildCommand,validateProvider,upstreamService,prepareRole,getAdapter} from './adapter.mjs';
import {validateResult,pageResult} from './result.mjs';
import {withFileLock} from './locking.mjs';
import {createWorkspace,assertWorkspace,workspaceRequest,ancestorInstructions,applyChanges,discardWorkspace,captureChanges} from './workspaces.mjs';
import {observeExecution,workspaceOptions} from './execution.mjs';
import {environment} from './adapters/common.mjs';

const TERMINAL=new Set(['completed','failed','cancelled','timed_out','interrupted']);
function taskDir(h,key){id(key,'task ID');return path.join(h.state_dir,'tasks',key);}
function metaPath(h,key){return path.join(taskDir(h,key),'task.json');}
function save(h,m){m.updated_at=new Date().toISOString();atomicJson(metaPath(h,m.task_id),m);return m;}
export function readTask(h,key){const m=readJson(metaPath(h,key),4*1024*1024);requireValue(m.host_id===h.host_id,'wrong_host','Task belongs to another host');return m;}
function taskKeys(h){const root=path.join(h.state_dir,'tasks');if(!fs.existsSync(root))return [];const entries=fs.readdirSync(root);requireValue(entries.length<=2000,'state_limit','More than 2000 task records; archive explicitly');return entries.filter(k=>fs.existsSync(metaPath(h,k)));}
function withTaskLock(h,key,fn){return withFileLock(path.join(h.state_dir,'locks',`${id(key,'task ID')}.lock`),fn);}
function receiptFor(h,m){const dir=taskDir(h,m.task_id),file=path.join(dir,'receipt.json');if(!fs.existsSync(file))return null;const r=readJson(file);requireValue(typeof r.process_dir==='string'&&within(path.join(dir,'upstream'),real(r.process_dir)),'invalid_receipt','Process directory outside task');return r;}
function shortStatus(m){return {task_id:m.task_id,root_task_id:m.root_task_id,parent_id:m.parent_id,sequence:m.sequence??0,role:m.snapshot.role_id,state:m.state,error:m.error??null,model:m.snapshot.model,effort:m.snapshot.effort,
  dispatch:{role:m.snapshot.role_id,label:m.snapshot.role.label,provider:m.snapshot.provider_id,cli:m.snapshot.provider.adapter,requested_model:m.snapshot.model,requested_effort:m.snapshot.effort,
    observed_model:m.observed_model??null,observed_effort:m.observed_effort??null,purpose:m.purpose??null,purpose_truncated:m.purpose_truncated??false,
    access:m.snapshot.role.access,permissions:m.snapshot.role.permissions??'restricted',provider_turns:m.provider_turns??null,native_session_reported:!!m.session_id},
  can_followup:!m.workspace_closed&&TERMINAL.has(m.state)&&!!m.session_id&&m.snapshot.discovery?.capabilities?.resume!==false,...(m.workspace_owner?{workspace_owner:m.workspace_owner,workspace_mode:m.snapshot.workspace_mode??'git-worktree',execution_report:m.execution_report??null}:{}),created_at:m.created_at,updated_at:m.updated_at};}
async function refreshUnlocked(h,key) {
  const m=readTask(h,key),dir=taskDir(h,key),before=JSON.stringify(m);
  if(['completed','failed','cancelled','timed_out'].includes(m.state))return m;
  const receipt=receiptFor(h,m);
  if(!receipt) {
    if(Date.now()-Date.parse(m.created_at)>15000){m.state='unknown';m.error='No launch receipt; recover or cancel by task ID; do not resubmit';}
  }else {
    const exitFile=path.join(receipt.process_dir,'exit-status.json'),alive=sameProcess(receipt.identity);
    if(m.cancel_requested&&alive&&!fs.existsSync(exitFile)&&m.cancel_signal_for!==hash(receipt.identity)) {
      try{
        if(process.platform==='win32')atomicJson(path.join(dir,'cancel.json'),{identity:receipt.identity});
        else process.kill(receipt.identity.pid,'SIGTERM');
        m.cancel_signal_for=hash(receipt.identity);
      }catch(e){if(e.code!=='ESRCH')throw e;}
    }
    if(fs.existsSync(exitFile)||!alive) {
      let observed;
      try{observed=await (m.workspace_owner?observeExecution(path.join(receipt.process_dir,'stdout.log')):getAdapter(m.snapshot.provider.adapter).observe(path.join(receipt.process_dir,'stdout.log')));}catch(e){observed={error:e.code??'invalid_result'};}
      m.observed_model=observed.model??null;m.observed_effort=observed.effective_effort??null;
      if(m.workspace_owner&&fs.existsSync(path.join(dir,'execution.json'))) {
        m.execution_report=path.join(dir,'execution.json');
        const report=readJson(m.execution_report,4*1024*1024);
        m.provider_turns=report.attempts.filter(a=>Object.hasOwn(a,'started_at')?a.started_at:a.provider).length;
      }else if(observed.session_id)m.provider_turns=1;
      // Retain native handles even on quota, malformed output, timeout, and cancellation.
      if(observed.session_id) {
        if(!m.expected_session_id||m.expected_session_id===observed.session_id)m.session_id=observed.session_id;
        else {observed.error='session_mismatch';m.session_id=null;}
      }else if(m.expected_session_id)m.session_id=m.expected_session_id;
      if(!fs.existsSync(exitFile)){m.state='interrupted';m.error='Runner exited without a final exit record';}
      else {
        const exit=readJson(exitFile);m.exit_code=exit.exitCode;
        if(exit.reason==='timeout'){m.state='timed_out';m.error='deadline_exceeded';}
        else if(m.cancel_requested){m.state='cancelled';m.error=null;}
        else try {
          requireValue(!observed.error,observed.error,'Provider failed');
          requireValue(exit.exitCode===0,'provider_exit_nonzero','Provider exited with a nonzero code');
          requireValue(observed.final,'invalid_result','No final provider result event');
          requireValue(!observed.model||observed.model===m.snapshot.model,'model_mismatch','Provider returned a different model');
          requireValue(!m.expected_session_id||observed.session_id===m.expected_session_id,'session_mismatch','Provider did not preserve the native session');
          validateResult(observed.data,m.snapshot.role.result_contract);
          atomicJson(path.join(dir,'result.json'),observed);m.state='completed';m.error=null;
        }catch(e){m.state='failed';m.error=e.code??'invalid_result';}
      }
    }else {m.state=m.cancel_requested?'cancelling':'running';m.error=null;}
  }
  if(JSON.stringify(m)!==before)save(h,m);return m;
}
async function refreshTask(h,key){return withTaskLock(h,key,()=>refreshUnlocked(h,key));}
export async function submit(h,{role,cwd,raw,requestId,overrides={},parentId=null}) {
  requireValue(['linux','win32'].includes(process.platform),'platform_unverified','Execution supports Linux/WSL and Windows');
  requireValue(process.env.AW_WORKER!=='1','delegation_forbidden','Leaf workers cannot submit tasks');id(requestId,'request ID');
  const parent=parentId?await refreshTask(h,parentId):null;
  const key='t_'+hash([h.host_id,raw.source??'local',requestId]).slice(0,32);
  const signature=hash({raw,role:parent?.snapshot.role_id??role??null,cwd:parent?.snapshot.cwd??real(cwd),parentId,overrides});
  if(fs.existsSync(metaPath(h,key))) {
    const found=readTask(h,key);requireValue(found.input_hash===signature,'request_conflict','Request ID already used with different input');return shortStatus(await refreshTask(h,key));
  }
  let snapshot;
  if(parent) {
    // Reapply current permission/project revocations, while keeping the native conversation's runtime/model pinned.
    const policy=resolveRole(h,parent.snapshot.role_id,parent.snapshot.cwd);
    requireValue(policy.role.execution==='worker'&&policy.role.access===parent.snapshot.role.access&&!policy.role.can_delegate,'role_not_executable','Current policy no longer permits this worker');
    requireValue((policy.role.permissions??'restricted')===(parent.snapshot.role.permissions??'restricted'),'permissions_changed','Permission preset changed; start an explicit new task instead of changing an existing session');
    requireValue(policy.provider_id===parent.snapshot.provider_id&&hash(policy.provider)===hash(parent.snapshot.provider),'provider_changed','Provider changed; start an explicit new conversation instead of silently migrating a native session');
    snapshot={...parent.snapshot,role:policy.role,project_instructions:policy.project_instructions,project_policy_files:policy.project_policy_files,runtime:policy.runtime};
  }else snapshot=resolveRole(h,role,cwd,overrides);
  const writing=snapshot.role.access==='workspace-write';
  if(writing) {
    const existing=new Set(snapshot.project_instructions.map(x=>x.path));
    snapshot.project_instructions=[...snapshot.project_instructions,...ancestorInstructions(snapshot.cwd).filter(x=>!existing.has(x.path))];
    if(parent&&!raw.execution)raw={...raw,execution:readJson(path.join(taskDir(h,parent.task_id),'request.json')).execution};
    snapshot.workspace_mode=workspaceOptions(raw.execution?.workspace).mode;
  }
  // Slow CLI discovery never holds the submission lock or blocks status/cancel.
  snapshot=await prepareRole(h,snapshot);
  requireValue(snapshot.runnable,'role_not_executable',snapshot.unavailable_reason??'Role not executable');
  let requestSnapshot=snapshot,requestRaw=raw;
  if(writing&&parent) {
    const workspace=readJson(path.join(taskDir(h,parent.workspace_owner),'workspace.json'),8*1024*1024);assertWorkspace(workspace);
    requestSnapshot={...snapshot,cwd:workspace.cwd};
    // Follow-ups can name files created by the worker, which do not exist in the source yet.
    requestRaw={...raw,read_paths:raw.read_paths?.map(p=>typeof p==='string'&&path.isAbsolute(p)&&within(snapshot.cwd,p)?path.join(workspace.cwd,path.relative(snapshot.cwd,p)):p)};
  }
  const prepared=prepareRequest(requestSnapshot,requestRaw);
  return withFileLock(path.join(h.state_dir,'submit.lock'),async()=>{
    if(fs.existsSync(metaPath(h,key))) {
      const found=readTask(h,key);requireValue(found.input_hash===signature,'request_conflict','Request ID already used with different input');return shortStatus(await refreshTask(h,key));
    }
    // Refresh the policy after waiting, so project revocation while another caller submits is respected.
    resolveRole(h,snapshot.role_id,snapshot.cwd);
    const all=[];for(const task of taskKeys(h))all.push(await refreshTask(h,task));
    requireValue(all.filter(m=>!TERMINAL.has(m.state)).length<h.limits.max_active_workers,'busy','Worker concurrency limit reached; recover unknown attempts by task ID');
    const root=parent?.root_task_id??key;let previous=parent;
    if(parent) {
      const turns=all.filter(m=>m.root_task_id===root).sort((a,b)=>(a.sequence??0)-(b.sequence??0));
      requireValue(turns.every(m=>TERMINAL.has(m.state)),'session_busy','This session has an active or unresolved turn');
      const latest=turns.at(-1);
      requireValue(latest.task_id===parentId||latest.state!=='completed','stale_parent',`Continue from latest completed turn ${latest.task_id}`);
      previous=latest;
      requireValue(previous.session_id&&snapshot.discovery.capabilities.resume,'resume_unsupported','Latest attempt has no resumable native session; an explicit new task is required');
    }
    const timeout=integer(raw.timeout_seconds??snapshot.limits.default_timeout_seconds,1,7200,'timeout_seconds');
    const dir=taskDir(h,key);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const service=await upstreamService(h,dir),promptFile=path.join(dir,'prompt.txt');
    let plan,workspace;
    if(writing) {
      if(previous) {
        workspace=readJson(path.join(taskDir(h,root),'workspace.json'),8*1024*1024);assertWorkspace(workspace);
        const previousRequest=readJson(path.join(taskDir(h,previous.task_id),'request.json'));
        const fixed=e=>[e.write_paths,e.setup,e.verification,workspaceOptions(e.workspace),e.checks??[],e.scratch_paths??[]];
        requireValue(hash(fixed(prepared.request.execution))===hash(fixed(previousRequest.execution)),'execution_scope_changed','A native execution session keeps its workspace mode, write scope, setup and checks; start a new task to change them');
        if(workspace.mode==='directory') {
          const reportFile=path.join(taskDir(h,previous.task_id),'execution.json');
          const report=fs.existsSync(reportFile)?readJson(reportFile,4*1024*1024):null;
          if(report?.outcome==='verified')requireValue(captureChanges(workspace,prepared.request.execution,dir).snapshot_hash===report.snapshot_hash,'workspace_changed','Directory contents changed after verification; reconcile explicitly before continuing');
        }
      }
      if(prepared.request.execution.workspace.mode==='directory'&&prepared.request.execution.workspace.target==='cwd') {
          for(const task of all.filter(m=>m.workspace_owner&&!TERMINAL.has(m.state))) {
            const active=readJson(path.join(taskDir(h,task.workspace_owner),'workspace.json'),8*1024*1024);
            requireValue(!within(active.root,snapshot.cwd)&&!within(snapshot.cwd,active.root),'workspace_busy','Another active task uses an overlapping execution directory');
          }
      }
      if(!workspace)workspace=createWorkspace(snapshot,dir,root,prepared.request);
      const executionPlan=path.join(dir,'execution-plan.json');
      atomicJson(executionPlan,{snapshot,workspace,directory:dir,request:workspaceRequest(prepared.request,workspace),session_id:previous?.session_id??null,run_setup:!previous});
      plan={command:process.execPath,args:[path.join(import.meta.dirname,'execution-worker.mjs'),executionPlan],cwd:workspace.cwd,env:environment(snapshot.provider),stdin_file:promptFile,receipt:path.join(dir,'receipt.json'),timeout_seconds:timeout};
    }else plan=buildCommand(snapshot,promptFile,path.join(dir,'receipt.json'),timeout,previous?.session_id);
    validateProvider(plan);
    fs.writeFileSync(promptFile,prepared.prompt,{mode:0o600});atomicJson(path.join(dir,'request.json'),prepared.request);
    const planFile=path.join(dir,'command.json');atomicJson(planFile,plan);
    const now=new Date().toISOString();
    const m={task_id:key,root_task_id:root,parent_id:previous?.task_id??null,requested_parent_id:parentId,sequence:(previous?.sequence??-1)+1,
      expected_session_id:previous?.session_id??null,host_id:h.host_id,state:'starting',snapshot,input_hash:signature,purpose:Array.from(prepared.request.goal).slice(0,500).join(''),purpose_truncated:Array.from(prepared.request.goal).length>500,...(workspace?{workspace_owner:root}:{}),created_at:now,updated_at:now};
    await withTaskLock(h,key,async()=>{
      atomicJson(metaPath(h,key),m);
      try {
        const started=await service.startPreparedProcess({cliPath:plan.command,args:[],cwd:plan.cwd,agent:snapshot.provider.adapter,prompt:'[stored in task prompt.txt]',resolvedModel:snapshot.model},planFile);
        m.upstream_pid=started.pid;m.launch_identity=processIdentity(started.pid);save(h,m);
      }catch{m.state='unknown';m.error='Launch outcome unknown; recover by task ID without resubmitting';save(h,m);}
    });
    return shortStatus(m);
  });
}
export async function status(h,key){return shortStatus(await refreshTask(h,key));}
export async function recover(h,key){const m=await refreshTask(h,key);return {...shortStatus(m),next_action:m.state==='unknown'?'Wait for a receipt or inspect the retained task directory; cancel records intent for a late receipt':m.session_id&&TERMINAL.has(m.state)?'Explicit followup may resume the native session':m.state==='running'?'Continue waiting':'Inspect the result or start an explicitly new task',task_directory:taskDir(h,key)};}
export async function wait(h,key,seconds=45){integer(seconds,0,60,'wait timeout');const end=Date.now()+seconds*1000;do{const s=await status(h,key);if(TERMINAL.has(s.state)||Date.now()>=end)return {...s,wait_timed_out:!TERMINAL.has(s.state)};await sleep(200);}while(true);}
export async function result(h,key,cursor){return withTaskLock(h,key,async()=>{
  const m=await refreshUnlocked(h,key);if(m.state!=='completed')return {...shortStatus(m),task_directory:taskDir(h,key)};
  const stored=readJson(path.join(taskDir(h,key),'result.json'),16*1024*1024);
  return {...shortStatus(m),...pageResult(stored,m.snapshot.limits,cursor),...(stored.execution?{execution:stored.execution,usage_scope:'last provider turn only; not the execution total'}:{}),report_path:path.join(taskDir(h,key),'result.json')};
});}
export async function workspaceAction(h,key,action='inspect',{write=false}={}) {
  requireValue(process.env.AW_WORKER!=='1','delegation_forbidden','Workers cannot apply or discard workspaces');
  requireValue(['inspect','apply','discard'].includes(action),'invalid_input','Unknown workspace action');
  return withFileLock(path.join(h.state_dir,'submit.lock'),async()=>{
    const m=await refreshTask(h,key);requireValue(m.workspace_owner,'no_workspace','Task has no managed execution workspace');
    const ownerDir=taskDir(h,m.workspace_owner),file=path.join(ownerDir,'workspace.json'),workspace=readJson(file,8*1024*1024);
    requireValue(workspace.owner===m.workspace_owner,'workspace_changed','Workspace owner mismatch');
    const expected=workspace.mode==='directory'?(workspace.owned?path.join(real(ownerDir),'output'):m.snapshot.cwd):path.join(real(ownerDir),'worktree');
    requireValue(workspace.root===expected&&workspace.source_cwd===m.snapshot.cwd,'workspace_changed','Workspace location differs from its owning task');
    const turns=[];for(const id of taskKeys(h)){const t=readTask(h,id);if(t.workspace_owner===m.workspace_owner)turns.push(await refreshTask(h,id));}
    turns.sort((a,b)=>a.sequence-b.sequence);const latest=turns.at(-1);
    const reportFile=path.join(taskDir(h,latest.task_id),'execution.json'),report=fs.existsSync(reportFile)?readJson(reportFile,4*1024*1024):null;
    if(action==='inspect')return {workspace,latest_task_id:latest.task_id,state:latest.state,report,report_path:report?reportFile:null};
    requireValue(turns.every(t=>TERMINAL.has(t.state)),'workspace_busy','Wait for or cancel every workspace task before applying/discarding');
    let result;
    if(action==='apply') {
      requireValue(workspace.mode!=='directory','apply_unsupported','Directory deliverables are already in the reported directory; there is no apply step');
      requireValue(latest.task_id===key,'stale_parent',`Apply the latest task ${latest.task_id}`);
      requireValue(latest.state==='completed'&&report,'unverified_changes','Only a completed verified execution can be applied');
      result=applyChanges(workspace,readJson(path.join(taskDir(h,key),'request.json')).execution,report,taskDir(h,key),{write});
    }else {
      requireValue(workspace.state!=='discarded','workspace_closed','Workspace already discarded');
      result={written:write,workspace:workspace.root,unapplied_changes:workspace.state!=='applied'};
      if(workspace.mode==='directory')result={written:write,workspace:workspace.root,removed:write&&workspace.owned,retained_directory:workspace.owned?null:workspace.root,rollback:false};
      if(write)discardWorkspace(workspace);
    }
    if(write) {
      workspace.state=action==='apply'?'applied':'discarded';atomicJson(file,workspace);
      for(const turn of turns)await withTaskLock(h,turn.task_id,async()=>{const current=readTask(h,turn.task_id);current.workspace_closed=true;save(h,current);});
    }
    return result;
  });
}
export async function cancel(h,key){return withTaskLock(h,key,async()=>{
  const m=await refreshUnlocked(h,key);if(TERMINAL.has(m.state))return shortStatus(m);
  m.cancel_requested=true;save(h,m);return shortStatus(await refreshUnlocked(h,key));
});}
