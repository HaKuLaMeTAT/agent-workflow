// The existing detached runner supervises this whole read/edit/verify/resume loop.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnCli,stopChild} from './process.mjs';
import {readJson,atomicJson,requireValue} from './core.mjs';
import {getAdapter,prepareRequest} from './adapter.mjs';
import {normalizeDelivery,deliverySchema} from './result.mjs';
import {environment} from './adapters/common.mjs';
import {commandDirectory,runFileCheck} from './execution.mjs';
import {captureChanges} from './workspaces.mjs';
import {guardedCommand} from './worker-policy.mjs';
import {remainingBudget,exhaustedBudget,sumCounters} from './budget.mjs';

const emit=value=>console.log(JSON.stringify(value));
async function runLogged(plan,directory,{timeout,onEvent,onStart}={}) {
  const stdout=path.join(directory,'stdout.log'),stderr=path.join(directory,'stderr.log');
  const out=fs.openSync(stdout,'w',0o600),err=fs.openSync(stderr,'w',0o600),input=plan.stdin_file?fs.openSync(plan.stdin_file,'r'):null;
  const started=Date.now();let child,timer,bytes=0,failure=null,buffer='';
  try {
    const exit=await new Promise(resolve=>{
      child=spawnCli(plan.command,plan.args,{cwd:plan.cwd,env:plan.env,stdio:[input??'ignore','pipe','pipe']});
      child.once('spawn',()=>onStart?.());
      const abort=error=>{failure??=error;stopChild(child,'SIGKILL');};
      if(timeout)timer=setTimeout(()=>abort('verification_timeout'),timeout*1000);
      child.once('error',()=>{failure='command_launch_failed';});
      for(const [key,fd] of [['stdout',out],['stderr',err]])child[key]?.on('data',data=>{
        bytes+=data.length;if(bytes>16*1024*1024){abort('output_too_large');return;}fs.writeSync(fd,data);
        if(key==='stdout'&&onEvent) {
          buffer+=data.toString();let end;
          while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let e;try{e=JSON.parse(line);}catch{}if(e)onEvent(e);}
        }
      });
      child.once('close',(code,signal)=>resolve({exit_code:code,signal}));
    });
    return {...exit,error:failure,duration_ms:Date.now()-started,stdout_path:stdout,stderr_path:stderr};
  }finally {clearTimeout(timer);fs.closeSync(out);fs.closeSync(err);if(input!==null)fs.closeSync(input);}
}
const tail=file=>{const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,4000));fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));return buffer.toString();}finally{fs.closeSync(fd);}};

export async function execute(plan) {
  const {workspace,directory}=plan;let snapshot={...plan.snapshot,cwd:workspace.cwd,execution:plan.request.execution,request:plan.request};
  const adapter=getAdapter(snapshot.provider.adapter),attempts=[],setup=[];
  let request=plan.request,session=plan.session_id??null,observed={session_id:session,model:null,usage:null,estimated_cost_usd:null},report;
  const reportPath=path.join(directory,'execution.json');
  const persist=extra=>{report={schema_version:1,workspace_mode:workspace.mode??'git-worktree',workspace_owner:workspace.owner,workspace:workspace.root,base_sha:workspace.base_sha??null,...(workspace.mode==='directory'?{recovery:'Direct writes; no automatic rollback',owned_directory:workspace.owned}:{}),outcome:'running',setup,setup_status:plan.run_setup?'requested':'reused_workspace',attempts,...extra};atomicJson(reportPath,report);};
  persist({});
  try {
    if(plan.run_setup&&request.execution.setup.length) {
      const before=captureChanges(workspace,request.execution,directory);
      for(let n=0;n<request.execution.setup.length;n++) {
        const v=request.execution.setup[n],dir=path.join(directory,`setup-${n+1}`);fs.mkdirSync(dir);
        const cwd=commandDirectory(workspace,v.cwd);
        const run=await runLogged({...v,cwd,env:environment(snapshot.provider)},dir,{timeout:v.timeout_seconds});
        setup.push({...v,cwd,...run});persist({});
        requireValue(!run.error&&run.exit_code===0,run.error??'setup_failed','Workspace setup failed before submitting a model task');
      }
      requireValue(captureChanges(workspace,request.execution,directory).snapshot_hash===before.snapshot_hash,'setup_changed_source','Setup must not change deliverable source files');
    }
    for(let index=0;index<request.execution.max_attempts;index++) {
      const used=sumCounters(attempts.map(a=>a.telemetry?.counters));
      const available=plan.snapshot.remaining_budget??request.budget;
      requireValue(!exhaustedBudget(available,used),'budget_exhausted','Execution attempts exhausted the shared work-package budget');
      snapshot={...snapshot,remaining_budget:remainingBudget(available,used)};
      const dir=path.join(directory,`attempt-${index+1}`);fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const files={directory:dir,prompt:path.join(dir,'prompt.txt'),schema:path.join(dir,'result-schema.json')};
      fs.writeFileSync(files.prompt,prepareRequest(snapshot,request).prompt,{mode:0o600});atomicJson(files.schema,deliverySchema(snapshot.role.result_contract));
      const command={...guardedCommand(adapter.prepare(snapshot,files,session),snapshot,files,{request,remaining:snapshot.remaining_budget}),cwd:workspace.cwd};
      const attempt={number:index+1,started_at:null,provider:null,verification:[]};attempts.push(attempt);persist({});
      const provider=await runLogged(command,dir,{onStart:()=>{attempt.started_at=new Date().toISOString();persist({});},onEvent:e=>{
        const id=e.type==='system'&&e.subtype==='init'?e.session_id:e.type==='thread.started'?e.thread_id:e.type==='aw_acp'?e.observation?.session_id:e.sessionID;
        if(id)emit({type:'aw_session',session_id:id});
      }});
      attempt.provider=provider;persist({});
      observed=await adapter.observe(provider.stdout_path);
      attempt.telemetry=observed.telemetry??null;
      attempt.observed_model=observed.model??null;attempt.observed_effort=observed.effective_effort??null;persist({});
      requireValue(!session||observed.session_id===session,'session_mismatch','Execution continuation did not preserve its native session');
      session=observed.session_id??session;
      requireValue(!provider.error,provider.error,'Provider process failed');
      requireValue(!observed.error,observed.error,'Provider failed');
      requireValue(provider.exit_code===0&&observed.final,'provider_exit_nonzero','Provider did not finish successfully');
      requireValue(!observed.model||observed.model===snapshot.model,'model_mismatch','Provider returned another model');
      const delivery=normalizeDelivery(observed.data,snapshot.role.result_contract);observed.data=delivery.data;observed.delivery??=delivery.delivery;
      requireValue(!observed.data.findings.some(f=>f.severity==='blocker'),'implementation_blocked','Worker reported an unresolved implementation blocker');
      const before=captureChanges(workspace,request.execution,dir);
      for(let n=0;n<request.execution.verification.length;n++) {
        const v=request.execution.verification[n],testDir=path.join(dir,`check-${n+1}`);fs.mkdirSync(testDir);
        const cwd=commandDirectory(workspace,v.cwd);
        const run=await runLogged({...v,cwd,env:environment(snapshot.provider)},testDir,{timeout:v.timeout_seconds});
        attempt.verification.push({...v,cwd,...run,snapshot_hash:before.snapshot_hash});persist({});
        // A command timeout/launch/output failure is operational, not a request for another paid turn.
        requireValue(!run.error,run.error,'Verification process failed; inspect retained logs');
      }
      for(let n=0;n<(request.execution.checks??[]).length;n++) {
        const checkDir=path.join(dir,`file-check-${n+1}`);fs.mkdirSync(checkDir);
        attempt.verification.push({...runFileCheck(workspace,request.execution.checks[n],checkDir),snapshot_hash:before.snapshot_hash});persist({});
      }
      const after=captureChanges(workspace,request.execution,dir);
      requireValue(before.snapshot_hash===after.snapshot_hash,'verification_changed_source','Verification modified source files; tests must be non-mutating');
      const patchPath=workspace.mode==='directory'?null:path.join(directory,'changes.patch');if(patchPath)fs.writeFileSync(patchPath,after.patch,{mode:0o600});
      const passed=attempt.verification.every(v=>v.exit_code===0)&&!observed.data.findings.some(f=>f.severity==='blocker');
      persist({outcome:passed?'verified':'verification_failed',files:after.files,artifacts:after.artifacts,patch_path:patchPath,patch_sha256:after.patch_sha256,snapshot_hash:after.snapshot_hash});
      if(passed)break;
      requireValue(index+1<request.execution.max_attempts,'verification_failed','Verification failed after the declared attempt budget');
      requireValue(session&&snapshot.discovery.capabilities.resume,'resume_unsupported','Cannot resume the execution worker');
      const feedback=attempt.verification.filter(v=>v.exit_code!==0).map(v=>({kind:v.kind??'command',command:v.command,args:v.args,path:v.path,type:v.type,exit_code:v.exit_code,stdout:tail(v.stdout_path),stderr:tail(v.stderr_path)}));
      request={...request,handoff:{...request.handoff,current_state:[...(request.handoff?.current_state??[]).slice(0,5),`AW verification feedback (task evidence): ${JSON.stringify(feedback)}. Correct the failure within write_paths; AW will rerun verification.`]}};
    }
    emit({type:'aw_execution_result',observation:{...observed,session_id:session},execution:{...report,report_path:reportPath}});
  }catch(e) {
    persist({...report,outcome:'failed',error:e.code??'execution_failed',message:e.message});
    emit({type:'aw_execution_result',observation:{...observed,session_id:session,error:e.code??'execution_failed'},execution:{...report,report_path:reportPath}});process.exitCode=1;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{await execute(readJson(process.argv[2],12*1024*1024));}catch(e){console.error(JSON.stringify({error:e.code??'execution_failed',message:e.message}));process.exitCode=1;}
}
