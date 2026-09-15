import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {providerFixture,runtimeFixture} from './fixtures/helpers.mjs';
import {loadHost,TOOL_ROOT,resolveRole} from '../src/config.mjs';
import {readJson,atomicJson,sleep} from '../src/core.mjs';
import {submit,wait,result,cancel,readTask,workspaceAction} from '../src/tasks.mjs';
import {prepareRole} from '../src/adapter.mjs';
import {scopeContains} from '../src/execution.mjs';
import {applyUpstreamPatch} from '../scripts/patch-upstream.mjs';
const upstream=process.env.AW_TEST_UPSTREAM,options={skip:!upstream?'Set AW_TEST_UPSTREAM for directory integration':false};
function fixture(t,adapter='claude') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw directory 中文 & space-')),project=path.join(root,'project');fs.mkdirSync(project);
  const runtime=path.join(root,'runtime');runtimeFixture(upstream,runtime);applyUpstreamPatch(runtime);
  const raw=readJson(path.join(TOOL_ROOT,'config/home.example.json'));raw.catalog=path.join(TOOL_ROOT,'config/roles.json');raw.state_dir=path.join(root,'state');raw.upstream_dir=runtime;
  const model=adapter==='claude'?'claude-sonnet-5':'fixture/model';
  raw.providers.worker={adapter,executable:providerFixture(root),args:['acp','dsh'].includes(adapter)?['--fixture-acp',...(adapter==='dsh'?['--fixture-dsh']:[])]:[],auth:'cli-managed',models:{[model]:['high']}};
  raw.bindings.executor={enabled:true,provider:'worker',model,effort:'high'};
  if(adapter==='dsh') {
    const previous=process.env.DSH_HOME;process.env.DSH_HOME=path.join(root,'dsh');const profile=path.join(process.env.DSH_HOME,'profiles/acp');fs.mkdirSync(profile,{recursive:true});atomicJson(path.join(profile,'package.json'),{});
    t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;});
  }
  const file=path.join(root,'host.json');atomicJson(file,raw);const h=loadHost(file);
  fs.writeFileSync(path.join(project,'input.txt'),'fixture source evidence');fs.writeFileSync(path.join(project,'untouched.txt'),'keep original');
  t.after(async()=>{const tasks=path.join(h.state_dir,'tasks');if(fs.existsSync(tasks))for(const id of fs.readdirSync(tasks))if(fs.existsSync(path.join(tasks,id,'task.json'))){await cancel(h,id);await wait(h,id,10);}fs.rmSync(root,{recursive:true,force:true});});
  const request=(goal='directory-good')=>({goal,acceptance:['Generate a readable report and valid JSON from the supplied input'],read_paths:['input.txt'],source:'directory-test',timeout_seconds:60,execution:{workspace:{mode:'directory'},write_paths:['out'],checks:[{type:'text',path:'out/report.md',contains:['fixture source evidence']},{type:'json',path:'out/result.json'}],max_attempts:2}});
  const run=(raw,id)=>submit(h,{role:'executor',cwd:project,raw,requestId:id});return {root,project,h,request,run};
}
for(const adapter of ['claude','codex','opencode','acp','dsh'])test(`directory ${adapter}: non-Git inputs, file checks, same-session repair and deliverables`,options,async t=>{
  const {project,h,request,run}=fixture(t,adapter),raw=request('directory-fix'),task=await run(raw,'files');
  assert.equal((await wait(h,task.task_id,40)).state,'completed');assert.equal((await run(raw,'files')).task_id,task.task_id);
  const output=await result(h,task.task_id),report=output.execution;
  assert.equal(task.dispatch.cli,adapter);assert.equal(task.dispatch.provider,'worker');assert.equal(task.dispatch.purpose,'directory-fix');
  assert.equal(task.dispatch.observed_model,null);assert.equal(output.dispatch.provider_turns,2);assert.equal(output.dispatch.native_session_reported,true);
  assert.equal(output.dispatch.requested_model,task.model);assert.equal(output.dispatch.requested_effort,'high');
  assert.equal(report.workspace_mode,'directory');assert.equal(report.patch_path,null);assert.equal(report.attempts.length,2);
  assert.equal(report.attempts[0].verification[1].exit_code,1);assert.equal(report.attempts[1].verification[1].exit_code,0);
  assert.equal(report.artifacts.length,2);assert.ok(report.artifacts.every(a=>a.status==='created'&&a.sha256&&path.isAbsolute(a.path)));
  assert.equal(fs.existsSync(path.join(project,'out')),false);assert.equal(fs.existsSync(path.join(report.workspace,'.git')),false);
  await assert.rejects(workspaceAction(h,task.task_id,'apply',{write:true}),{code:'apply_unsupported'});
  const follow=request();delete follow.execution;follow.read_paths=['out/result.json'];
  const next=await submit(h,{parentId:task.task_id,raw:follow,requestId:'continue'});assert.equal((await wait(h,next.task_id,40)).state,'completed');
  assert.equal(next.dispatch.purpose,'directory-good');assert.equal((await result(h,next.task_id)).dispatch.provider_turns,1);
  assert.equal(readTask(h,next.task_id).session_id,readTask(h,task.task_id).session_id);
  await workspaceAction(h,next.task_id,'discard',{write:true});assert.equal(fs.existsSync(report.workspace),false);
});

test('directory cwd: explicit overwrite, no apply, and cleanup never removes the supplied directory',options,async t=>{
  const {project,h,request,run}=fixture(t);fs.mkdirSync(path.join(project,'out'));fs.writeFileSync(path.join(project,'out/report.md'),'old report');
  const raw=request();raw.execution.workspace={mode:'directory',target:'cwd'};
  await assert.rejects(run(raw,'deny'),{code:'overwrite_not_allowed'});assert.equal(fs.readFileSync(path.join(project,'out/report.md'),'utf8'),'old report');
  raw.execution.workspace.overwrite='allow';const task=await run(raw,'allow');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  const report=(await result(h,task.task_id)).execution;assert.equal(report.workspace,fs.realpathSync(project));assert.ok(report.artifacts.some(a=>a.status==='modified'));
  const closed=await workspaceAction(h,task.task_id,'discard',{write:true});assert.equal(closed.removed,false);assert.equal(closed.rollback,false);
  assert.ok(fs.existsSync(path.join(project,'out/report.md')));assert.equal(fs.readFileSync(path.join(project,'untouched.txt'),'utf8'),'keep original');
});

test('directory: scope violation is reported without implicit rollback; Git failures do not switch modes',options,async t=>{
  const {project,h,request,run}=fixture(t),raw=request('directory-outside');raw.read_paths.push('untouched.txt');
  const task=await run(raw,'outside');assert.equal((await wait(h,task.task_id,30)).error,'write_scope_exceeded');
  assert.equal(fs.readFileSync(path.join(project,'untouched.txt'),'utf8'),'keep original');
  const workspace=(await workspaceAction(h,task.task_id)).workspace;assert.equal(fs.readFileSync(path.join(workspace.root,'untouched.txt'),'utf8'),'outside change');
  const git=request();delete git.execution.workspace;git.execution.verification=[{command:process.execPath,args:['-e','process.exit(0)']}];
  await assert.rejects(run(git,'requires-git'),e=>['git_failed','git_unavailable'].includes(e.code));assert.equal(fs.existsSync(path.join(project,'out')),false);
});

test('directory: Git is not a prepare or execution dependency',options,async t=>{
  const {root,project,h,request,run}=fixture(t),previous=process.env.PATH,bin=path.join(root,'bin');fs.mkdirSync(bin);
  if(process.platform==='linux')fs.symlinkSync('/usr/bin/flock',path.join(bin,'flock'));
  process.env.PATH=[path.dirname(process.execPath),bin].join(path.delimiter);
  t.after(()=>{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;});
  const selected=await prepareRole(h,resolveRole(h,'executor',project),{workspaceMode:'directory'});assert.equal(selected.runnable,true,selected.unavailable_reason);
  const git=await prepareRole(h,resolveRole(h,'executor',project));assert.equal(git.unavailable_reason,'git_unavailable');
  const task=await run(request(),'no-git');assert.equal((await wait(h,task.task_id,30)).state,'completed');
});

test('directory: setup scratch space, non-mutating verification and zero-call failures',options,async t=>{
  const {project,h,request,run}=fixture(t),raw=request();
  raw.execution.scratch_paths=['.cache'];raw.execution.setup=[{command:process.execPath,args:['-e',"require('fs').mkdirSync('.cache');require('fs').writeFileSync('.cache/prepared','ok')"]}];
  const task=await run(raw,'scratch');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  const report=(await result(h,task.task_id)).execution;assert.equal(report.artifacts.length,2);assert.ok(fs.existsSync(path.join(report.workspace,'.cache/prepared')));
  const failed=request();failed.execution.setup=[{command:process.execPath,args:['-e','process.exit(1)']}];
  const blocked=await run(failed,'setup-failure');const stopped=await wait(h,blocked.task_id,30);
  assert.equal(stopped.error,'setup_failed');assert.equal(stopped.dispatch.provider_turns,0);assert.equal(stopped.dispatch.observed_model,null);assert.equal(stopped.dispatch.native_session_reported,false);
  const mutating=request();mutating.execution.verification=[{command:process.execPath,args:['-e',"require('fs').appendFileSync('out/report.md','mutated')"]}];
  const changed=await run(mutating,'mutated-check');assert.equal((await wait(h,changed.task_id,30)).error,'verification_changed_source');
  assert.equal(fs.existsSync(path.join(project,'out')),false);
  assert.equal(scopeContains(['OUT'],'out/report.md'),process.platform==='win32');
  if(process.platform==='win32') {
    const mixed=request();mixed.execution.scratch_paths=['OUT'];await assert.rejects(run(mixed,'case-overlap'),{code:'invalid_input'});
    const upper=request();upper.execution.write_paths=['OUT'];const task=await run(upper,'case-allowed');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  }
});

test('directory: immutable continuation, external edits, replaced roots and stable dispatch facts',options,async t=>{
  const {h,request,run}=fixture(t),task=await run(request(),'original');assert.equal((await wait(h,task.task_id,30)).state,'completed');
  const output=await result(h,task.task_id),root=output.execution.workspace,original=fs.readFileSync(path.join(root,'out/report.md'));
  h.bindings.executor.model='claude-opus-5';assert.equal((await result(h,task.task_id)).dispatch.requested_model,task.dispatch.requested_model);h.bindings.executor.model=task.model;
  const next=request();next.execution.workspace.target='cwd';
  await assert.rejects(submit(h,{parentId:task.task_id,raw:next,requestId:'mode-change'}),{code:'execution_scope_changed'});
  delete next.execution;fs.appendFileSync(path.join(root,'out/report.md'),'external edit');
  await assert.rejects(submit(h,{parentId:task.task_id,raw:next,requestId:'external-edit'}),{code:'workspace_changed'});
  fs.writeFileSync(path.join(root,'out/report.md'),original);fs.renameSync(root,root+'-retained');fs.mkdirSync(root);
  await assert.rejects(submit(h,{parentId:task.task_id,raw:next,requestId:'replaced'}),{code:'workspace_changed'});
});

test('directory: overlapping direct writes are rejected and cancellation retains files',options,async t=>{
  const {project,h,request,run}=fixture(t),raw=request('hang');raw.execution.workspace={mode:'directory',target:'cwd'};raw.execution.write_paths.push('descendant.pid');
  const task=await run(raw,'active');
  for(let n=0;n<150&&!fs.existsSync(path.join(project,'descendant.pid'));n++)await sleep(100);
  assert.ok(fs.existsSync(path.join(project,'descendant.pid')));
  const overlapping=request();overlapping.execution.workspace={mode:'directory',target:'cwd'};
  await assert.rejects(run(overlapping,'overlap'),{code:'workspace_busy'});
  await cancel(h,task.task_id);const stopped=await wait(h,task.task_id,30);assert.equal(stopped.state,'cancelled');assert.equal(stopped.dispatch.provider_turns,1);
  assert.ok(fs.existsSync(path.join(project,'descendant.pid')));const closed=await workspaceAction(h,task.task_id,'discard',{write:true});
  assert.equal(closed.removed,false);assert.equal(fs.readFileSync(path.join(project,'input.txt'),'utf8'),'fixture source evidence');
});
