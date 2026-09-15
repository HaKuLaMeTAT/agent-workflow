import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {providerFixture,runtimeFixture} from './fixtures/helpers.mjs';
import {loadHost,TOOL_ROOT,resolveRole} from '../src/config.mjs';
import {readJson,atomicJson,sleep,processIdentity,sameProcess} from '../src/core.mjs';
import {submit,wait,result,cancel,readTask,workspaceAction} from '../src/tasks.mjs';
import {git} from '../src/workspaces.mjs';
import {prepareRequest,prepareRole} from '../src/adapter.mjs';
import {applyUpstreamPatch} from '../scripts/patch-upstream.mjs';
const upstream=process.env.AW_TEST_UPSTREAM;
const options={skip:!upstream?'Set AW_TEST_UPSTREAM for execution integration':false};

function fixture(t,adapter='claude',permissions='restricted') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw execute 中文 & space-')),project=path.join(root,'project');fs.mkdirSync(project);
  const runtime=path.join(root,'runtime');runtimeFixture(upstream,runtime);applyUpstreamPatch(runtime);
  const host=readJson(path.join(TOOL_ROOT,'config/home.example.json'));host.catalog=path.join(TOOL_ROOT,'config/roles.json');host.state_dir=path.join(root,'state');host.upstream_dir=runtime;
  const executable=providerFixture(root),model=adapter==='claude'?'claude-sonnet-5':adapter==='codex'?'gpt-5.6-luna':'fixture/model';
  host.providers.worker={adapter,executable,args:['acp','dsh'].includes(adapter)?['--fixture-acp',...(adapter==='dsh'?['--fixture-dsh']:[])]:[],auth:'cli-managed',models:{[model]:['high']}};
  host.bindings.executor={enabled:true,provider:'worker',model,effort:'high',permissions};
  if(adapter==='dsh') {
    const previous=process.env.DSH_HOME;process.env.DSH_HOME=path.join(root,'dsh');
    const profile=path.join(process.env.DSH_HOME,'profiles/acp');fs.mkdirSync(profile,{recursive:true});atomicJson(path.join(profile,'package.json'),{});
    t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;});
  }
  const hostFile=path.join(root,'host.json');atomicJson(hostFile,host);const h=loadHost(hostFile);
  git(project,['init']);git(project,['config','user.name','AW fixture']);git(project,['config','user.email','aw-test@example.invalid']);
  fs.mkdirSync(path.join(project,'src'));
  fs.writeFileSync(path.join(project,'.gitignore'),'node_modules/\n');
  fs.writeFileSync(path.join(project,'src/math.mjs'),'export const add = () => 0;\n');fs.writeFileSync(path.join(project,'src/remove.txt'),'remove me');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Preserve the sum API. Do not weaken verification.');
  fs.writeFileSync(path.join(project,'verify.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';import {add} from './src/math.mjs';
if(process.argv[2]==='mutate')fs.appendFileSync('src/math.mjs','// mutated by verification\\n');
if(process.argv[2]==='hang'){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(c.pid));setInterval(()=>{},1000);}else {assert.equal(add(2,3),5);assert.deepEqual([...fs.readFileSync('src/new.bin')],[0,1,2,255]);assert.equal(fs.existsSync('src/remove.txt'),false);console.log('sum verified');}
`);
  atomicJson(path.join(project,'agent-workflow.json'),{schema_version:1,allowed_roles:['executor','reviewer'],instructions:[],workflows:{implement:'executor'}});
  git(project,['add','.']);git(project,['commit','-m','fixture baseline']);
  t.after(async()=>{
    const tasks=path.join(h.state_dir,'tasks');
    if(fs.existsSync(tasks))for(const name of fs.readdirSync(tasks))if(fs.existsSync(path.join(tasks,name,'task.json'))){await cancel(h,name);await wait(h,name,10);}
    fs.rmSync(root,{recursive:true,force:true});
  });
  const request=(goal='execute-fix',extra={})=>({goal,acceptance:['add(2, 3) returns 5 without weakening tests'],read_paths:['src/math.mjs'],handoff:{attempted:['Current implementation returns zero'],constraints:['Preserve the public export']},source:'execution-test',timeout_seconds:60,execution:{write_paths:['src'],verification:[{command:process.execPath,args:['verify.mjs'],timeout_seconds:10}],max_attempts:2},...extra});
  const run=(raw,id)=>submit(h,{role:'executor',cwd:project,raw,requestId:id});
  return {root,project,h,request,run};
}

test('execution: read/edit/test/fix in one native session; receive, apply and discard owned changes',options,async t=>{
  const {project,h,request,run}=fixture(t),before=fs.readFileSync(path.join(project,'src/math.mjs'),'utf8');
  const raw=request();raw.execution.setup=[{command:process.execPath,args:['-e',"const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});const p='node_modules/setup-count';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));"],timeout_seconds:10}];
  const task=await run(raw,'fix');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  assert.equal((await run(raw,'fix')).task_id,task.task_id,'Idempotent resubmission must not create another workspace/model turn');
  const output=await result(h,task.task_id),report=output.execution;
  assert.equal(report.outcome,'verified');assert.equal(report.attempts.length,2);
  assert.equal(report.setup[0].exit_code,0);
  assert.equal(report.attempts[0].verification[0].exit_code,1);assert.equal(report.attempts[1].verification[0].exit_code,0);
  assert.equal(report.attempts[1].verification[0].snapshot_hash,report.snapshot_hash);
  assert.match(fs.readFileSync(report.attempts[1].verification[0].stdout_path,'utf8'),/sum verified/);
  assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8'),before);
  const prompt=fs.readFileSync(path.join(h.state_dir,'tasks',task.task_id,'attempt-1','prompt.txt'),'utf8');assert.match(prompt,/Preserve the sum API/);
  const follow=request('execute-good');delete follow.execution;follow.read_paths=['src/new.bin'];
  h.bindings.executor.permissions='full-access';
  await assert.rejects(submit(h,{parentId:task.task_id,raw:follow,requestId:'permission-change'}),{code:'permissions_changed'});
  h.bindings.executor.permissions='restricted';
  const next=await submit(h,{parentId:task.task_id,raw:follow,requestId:'follow'});
  assert.equal((await wait(h,next.task_id,30)).state,'completed');
  assert.equal(readTask(h,next.task_id).session_id,readTask(h,task.task_id).session_id);
  const workspace=(await workspaceAction(h,next.task_id)).workspace;
  assert.equal(fs.readFileSync(path.join(workspace.root,'node_modules/setup-count'),'utf8'),'1');
  assert.equal(workspace.owner,task.task_id);
  const finalReport=(await result(h,next.task_id)).execution,patch=fs.readFileSync(finalReport.patch_path);
  fs.appendFileSync(finalReport.patch_path,'tampered');await assert.rejects(workspaceAction(h,next.task_id,'apply',{write:true}),{code:'artifact_changed'});fs.writeFileSync(finalReport.patch_path,patch);
  await assert.rejects(workspaceAction(h,task.task_id,'apply'),{code:'stale_parent'});
  fs.writeFileSync(path.join(project,'unrelated.txt'),'user change');
  await assert.rejects(workspaceAction(h,next.task_id,'apply',{write:true}),{code:'dirty_source'});fs.unlinkSync(path.join(project,'unrelated.txt'));
  const verified=fs.readFileSync(path.join(workspace.root,'src/math.mjs'),'utf8');
  fs.appendFileSync(path.join(workspace.root,'src/math.mjs'),'// later edit\n');
  await assert.rejects(workspaceAction(h,next.task_id,'apply',{write:true}),{code:'workspace_changed'});fs.writeFileSync(path.join(workspace.root,'src/math.mjs'),verified);
  assert.equal((await workspaceAction(h,next.task_id,'apply')).written,false);assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8'),before);
  assert.equal((await workspaceAction(h,next.task_id,'apply',{write:true})).written,true);
  // git apply honors the source repository's checkout EOL policy on Windows.
  assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8').replaceAll('\r\n','\n'),verified);assert.deepEqual([...fs.readFileSync(path.join(project,'src/new.bin'))],[0,1,2,255]);assert.equal(fs.existsSync(path.join(project,'src/remove.txt')),false);
  assert.match(execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8'}),/sum verified/);
  assert.equal(git(project,['diff','--cached','--name-only']).length,0,'Apply must not stage the user index');
  await assert.rejects(submit(h,{parentId:next.task_id,raw:follow,requestId:'closed'}),{code:'workspace_closed'});
  await workspaceAction(h,next.task_id,'discard',{write:true});assert.equal(fs.existsSync(workspace.root),false);assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8').replaceAll('\r\n','\n'),verified);
});

test('execution: reject dirty baseline, out-of-scope changes and mutating verification',options,async t=>{
  const {project,h,request,run}=fixture(t);
  fs.writeFileSync(path.join(project,'uncommitted.txt'),'local');await assert.rejects(run(request(),'dirty'),{code:'dirty_source'});fs.unlinkSync(path.join(project,'uncommitted.txt'));
  const bad=await run(request('execute-outside'),'outside');assert.equal((await wait(h,bad.task_id,30)).error,'write_scope_exceeded');
  const badInfo=await workspaceAction(h,bad.task_id);assert.equal(badInfo.report.attempts[0].verification.length,0);
  assert.equal(fs.existsSync(path.join(project,'outside.txt')),false);await assert.rejects(workspaceAction(h,bad.task_id,'apply'),{code:'unverified_changes'});
  await workspaceAction(h,bad.task_id,'discard',{write:true});
  const req=request('execute-good');req.execution.verification[0].args.push('mutate');
  const mutated=await run(req,'mutated');assert.equal((await wait(h,mutated.task_id,30)).error,'verification_changed_source');
  assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8'),'export const add = () => 0;\n');
  const noRetry=request();noRetry.execution.max_attempts=1;
  const failed=await run(noRetry,'budget');assert.equal((await wait(h,failed.task_id,30)).error,'verification_failed');assert.equal((await workspaceAction(h,failed.task_id)).report.attempts.length,1);
  const setup=request('execute-good');setup.execution.setup=[{command:process.execPath,args:['-e','process.exit(9)']}];
  const setupTask=await run(setup,'setup-failure');assert.equal((await wait(h,setupTask.task_id,30)).error,'setup_failed');assert.equal((await workspaceAction(h,setupTask.task_id)).report.attempts.length,0);
});

test('execution: cancellation/deadline reap verification descendants and retain the workspace',options,async t=>{
  const {h,request,run}=fixture(t);
  for(const mode of ['cancel','timeout','command-timeout']) {
    const req=request('execute-good');req.execution.verification[0].args.push('hang');req.execution.verification[0].timeout_seconds=30;if(mode==='timeout')req.timeout_seconds=process.platform==='win32'?12:4;
    if(mode==='command-timeout')req.execution.verification[0].timeout_seconds=2;
    const task=await run(req,mode),workspace=(await workspaceAction(h,task.task_id)).workspace;
    const pidFile=path.join(workspace.root,'descendant.pid');
    for(let n=0;n<180&&!fs.existsSync(pidFile);n++)await sleep(100);
    assert.ok(fs.existsSync(pidFile));const identity=processIdentity(Number(fs.readFileSync(pidFile,'utf8')));assert.ok(identity);
    if(mode==='cancel'){await assert.rejects(workspaceAction(h,task.task_id,'discard',{write:true}),{code:'workspace_busy'});await cancel(h,task.task_id);}
    const terminal=await wait(h,task.task_id,30);
    assert.equal(terminal.state,mode==='cancel'?'cancelled':mode==='timeout'?'timed_out':'failed');if(mode==='command-timeout')assert.equal(terminal.error,'verification_timeout');
    assert.equal(sameProcess(identity),false);assert.ok(fs.existsSync(workspace.root));
    await workspaceAction(h,task.task_id,'discard',{write:true});
  }
});

test('execution request: scope/rule escapes rejected and read-only adapters stay read-only',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw-execution-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const h=loadHost(path.join(TOOL_ROOT,'config/home.example.json'));h.bindings.executor.enabled=true;
  const snapshot=resolveRole(h,'executor',root);
  const request={goal:'implement',acceptance:['verify'],read_paths:[],execution:{write_paths:['src'],verification:[{command:process.execPath,args:['test.mjs']}]}};
  for(const p of ['../escape','src/../../escape','.git','src),Bash(*)','src/**','C:/other','src\\other'])assert.throws(()=>prepareRequest(snapshot,{...request,execution:{...request.execution,write_paths:[p]}}),{code:'invalid_input'});
  assert.throws(()=>prepareRequest(resolveRole(h,'reviewer',root),request),{code:'permission_unsupported'});
  assert.equal(prepareRequest(snapshot,request).request.execution.max_attempts,2);
  const previousPath=process.env.PATH;process.env.PATH='';
  try {assert.equal(prepareRequest(snapshot,{...request,execution:{...request.execution,verification:[{command:'node',args:['test.mjs']}]}}).request.execution.verification[0].command,process.execPath);}
  finally {if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;}
});

for(const adapter of ['claude','codex','opencode','acp','dsh'])for(const permissions of (adapter==='claude'?['full-access']:['restricted','full-access']))test(`execution ${adapter}/${permissions}: native resume, verification and apply`,options,async t=>{
  const {project,h,request,run}=fixture(t,adapter,permissions),task=await run(request(),'multi');
  const terminal=await wait(h,task.task_id,45);assert.equal(terminal.state,'completed',JSON.stringify(terminal));
  const output=await result(h,task.task_id),report=output.execution;
  assert.equal(report.outcome,'verified');assert.equal(report.attempts.length,2);
  assert.equal(report.attempts[0].verification[0].exit_code,1);assert.equal(report.attempts[1].verification[0].exit_code,0);
  assert.ok(readTask(h,task.task_id).session_id);
  assert.equal(fs.readFileSync(path.join(project,'src/math.mjs'),'utf8'),'export const add = () => 0;\n');
  await workspaceAction(h,task.task_id,'apply',{write:true});
  assert.match(execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8'}),/sum verified/);
  await workspaceAction(h,task.task_id,'discard',{write:true});
});

test('Codex model selection: explicit models outside the cache can run without a host allowlist',options,async t=>{
  const {h,project,request,run}=fixture(t,'codex');delete h.providers.worker.models;
  for(const [model,effort] of [['custom-codex-fast','low'],['another-codex-model',null]]) {
    h.bindings.executor.model=model;h.bindings.executor.effort=effort;
    const selected=await prepareRole(h,resolveRole(h,'executor',project));
    assert.equal(selected.runnable,true,selected.unavailable_reason);assert.equal(selected.model,model);assert.equal(selected.effort,effort);
    assert.equal(selected.discovery.models[0].source,'explicit_binding');assert.equal(selected.discovery.models[0].verified,false);
  }
  const task=await run(request('execute-good'),'custom-model');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  assert.equal(readTask(h,task.task_id).snapshot.model,'another-codex-model');
  await workspaceAction(h,task.task_id,'discard',{write:true});
});
