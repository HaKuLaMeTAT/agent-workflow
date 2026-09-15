import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {providerFixture,runtimeFixture} from './fixtures/helpers.mjs';
import {loadHost,TOOL_ROOT} from '../src/config.mjs';
import {atomicJson,readJson,processIdentity,sameProcess,sleep} from '../src/core.mjs';
import {submit,wait,result,cancel,status,readTask} from '../src/tasks.mjs';
import {applyUpstreamPatch} from '../scripts/patch-upstream.mjs';
import {checkRuntime} from '../src/runtime.mjs';
const upstream=process.env.AW_TEST_UPSTREAM;
const options={skip:!upstream?'Set AW_TEST_UPSTREAM to an unmodified ai-cli-mcp 2.25.0 package to run real process integration':false};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw process 中文-'));
  const runtime=path.join(root,'upstream');runtimeFixture(upstream,runtime);
  assert.equal(applyUpstreamPatch(runtime).status,'applied');assert.equal(applyUpstreamPatch(runtime).status,'already_applied');
  const binary=providerFixture(root);
  const host=readJson(path.join(TOOL_ROOT,'config/home.example.json'));
  host.catalog=path.join(TOOL_ROOT,'config/roles.json');host.state_dir=path.join(root,'state');host.upstream_dir=runtime;
  host.providers['claude-local'].executable=binary;
  const file=path.join(root,'host.json');atomicJson(file,host);const h=loadHost(file);
  t.after(async()=>{
    const tasks=path.join(h.state_dir,'tasks');
    if(fs.existsSync(tasks))for(const entry of fs.readdirSync(tasks)) {
      const r=path.join(tasks,entry,'receipt.json');if(!fs.existsSync(r))continue;
      const receipt=readJson(r);
      if(sameProcess(receipt.identity)){await cancel(h,entry);await wait(h,entry,10);}
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,file,h};
}
const request=(goal,timeout_seconds=10)=>({goal,acceptance:['return a structured result'],read_paths:[],source:'integration',timeout_seconds});
async function childPid(root) {
  for(let i=0;i<150;i++){const f=path.join(root,'descendant.pid');if(fs.existsSync(f))return Number(fs.readFileSync(f,'utf8'));await sleep(100);}
  throw new Error('Provider did not create descendant');
}
test('real runner: caller exit, idempotency, native followup and configuration snapshot',options,async t=>{
  const {root,file,h}=fixture(t), req=path.join(root,'request.json');atomicJson(req,request('first'));
  atomicJson(path.join(root,'agent-workflow.json'),{schema_version:1,allowed_roles:['reviewer','designer'],instructions:[],workflows:{review:'reviewer'}});
  const call=()=>promisify(execFile)(process.execPath,[path.join(TOOL_ROOT,'bin/aw.mjs'),'run','--host-config',file,'--role','reviewer','--cwd',root,'--request-file',req,'--request-id','one'],{encoding:'utf8',timeout:30000});
  const callers=await Promise.all([call(),call()]);
  const first=JSON.parse(callers[0].stdout);assert.equal(JSON.parse(callers[1].stdout).task_id,first.task_id);
  assert.equal((await wait(h,first.task_id,10)).state,'completed');
  assert.equal((await submit(h,{role:'reviewer',cwd:root,raw:request('first'),requestId:'one'})).task_id,first.task_id);
  await assert.rejects(submit(h,{role:'reviewer',cwd:root,raw:request('different'),requestId:'one'}),{code:'request_conflict'});
  const config=readJson(file);config.bindings.reviewer.effort='low';atomicJson(file,config);
  const h2=loadHost(file), next=await submit(h2,{parentId:first.task_id,raw:request('followup'),requestId:'two'});
  assert.equal(next.effort,'high');assert.equal((await wait(h2,next.task_id,10)).state,'completed');
  assert.equal(readTask(h2,next.task_id).session_id,readTask(h2,first.task_id).session_id);
  const full=await result(h2,next.task_id,0);assert.equal(JSON.parse(full.text).payload.resumed,true);
  await assert.rejects(submit(h2,{parentId:first.task_id,raw:request('fork'),requestId:'three'}),{code:'stale_parent'});
  const failed=await submit(h2,{parentId:next.task_id,raw:request('quota'),requestId:'quota-followup'});
  assert.equal((await wait(h2,failed.task_id,10)).error,'quota_exhausted');
  const resumed=await submit(h2,{parentId:next.task_id,raw:request('after-quota'),requestId:'recovered'});
  assert.equal(resumed.parent_id,failed.task_id);assert.equal((await wait(h2,resumed.task_id,10)).state,'completed');
  assert.equal(readTask(h2,resumed.task_id).session_id,readTask(h2,first.task_id).session_id);
  atomicJson(path.join(root,'agent-workflow.json'),{schema_version:1,allowed_roles:['designer'],instructions:[]});
  await assert.rejects(submit(h2,{parentId:next.task_id,raw:request('revoked'),requestId:'revoked'}),{code:'role_not_allowed'});
});
test('real runner: cancellation and deadline terminate the CLI process group',options,async t=>{
  const {root,h}=fixture(t);
  const first=await submit(h,{role:'reviewer',cwd:root,raw:request('hang'),requestId:'cancel'});
  const descendant=await childPid(root), identity=processIdentity(descendant);
  assert.ok(identity);
  const directory=path.join(h.state_dir,'tasks',first.task_id),receipt=readJson(path.join(directory,'receipt.json'));
  fs.unlinkSync(path.join(directory,'receipt.json'));
  const metadata=readTask(h,first.task_id);metadata.state='unknown';metadata.created_at=new Date(Date.now()-60000).toISOString();atomicJson(path.join(directory,'task.json'),metadata);
  assert.equal((await cancel(h,first.task_id)).state,'unknown');
  atomicJson(path.join(directory,'receipt.json'),receipt); // A late receipt must honor the saved cancellation.
  assert.equal((await wait(h,first.task_id,10)).state,'cancelled');assert.equal(sameProcess(identity),false);
  fs.unlinkSync(path.join(root,'descendant.pid'));
  const second=await submit(h,{role:'reviewer',cwd:root,raw:request('hang',process.platform==='win32'?4:1),requestId:'timeout'});
  const identity2=processIdentity(await childPid(root));assert.ok(identity2);
  assert.equal((await wait(h,second.task_id,10)).state,'timed_out');assert.equal(sameProcess(identity2),false);
  fs.unlinkSync(path.join(root,'descendant.pid'));
  const orphan=await submit(h,{role:'reviewer',cwd:root,raw:request('orphan'),requestId:'orphan'});
  const orphanPid=await childPid(root);
  assert.equal((await wait(h,orphan.task_id,10)).state,'completed');
  assert.equal(processIdentity(orphanPid),null,'Completion must also reap descendants whose parent exited');
});
test('real runner: invalid final output fails; stale PID is observed without signalling',options,async t=>{
  const {root,h}=fixture(t);
  const bad=await submit(h,{role:'reviewer',cwd:root,raw:request('invalid-result'),requestId:'bad'});
  const finished=await wait(h,bad.task_id,10);assert.equal(finished.state,'failed');assert.equal(finished.error,'invalid_result');
  const quota=await submit(h,{role:'reviewer',cwd:root,raw:request('quota'),requestId:'quota'});
  assert.equal((await wait(h,quota.task_id,10)).error,'quota_exhausted');
  const retried=await submit(h,{parentId:quota.task_id,raw:request('incomplete'),requestId:'retry-failed'});
  assert.equal((await wait(h,retried.task_id,10)).state,'completed');assert.equal((await result(h,retried.task_id)).verdict,'incomplete');
  // A dead legacy marker has no lock ownership; kernel locks release when the caller dies.
  fs.writeFileSync(path.join(h.state_dir,'submit.lock'),JSON.stringify({identity:{pid:999999,start_ticks:'dead',boot_id:'dead'}}));
  const holder=spawn(process.execPath,['--input-type=module','-e',`import {withFileLock} from ${JSON.stringify(pathToFileURL(path.join(TOOL_ROOT,'src/locking.mjs')).href)};await withFileLock(process.argv[1],async()=>{console.log('ready');await new Promise(()=>{});});`,path.join(h.state_dir,'submit.lock')],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(holder.exitCode===null)holder.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject);holder.once('exit',()=>reject(new Error('Lock holder exited before ready')));});
  assert.equal((await status(h,retried.task_id)).state,'completed');
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
  const afterCrash=await submit(h,{role:'reviewer',cwd:root,raw:request('after-lock-crash'),requestId:'lock-recovery'});assert.equal((await wait(h,afterCrash.task_id,10)).state,'completed');
  const meta=readTask(h,bad.task_id), dir=path.join(h.state_dir,'tasks',bad.task_id);
  meta.state='running';atomicJson(path.join(dir,'task.json'),meta);
  const processDir=path.join(dir,'upstream','stale');fs.mkdirSync(processDir);
  atomicJson(path.join(dir,'receipt.json'),{identity:{...processIdentity(process.pid),start_ticks:'wrong'},process_dir:processDir});
  assert.equal((await status(h,bad.task_id)).state,'interrupted');
  assert.equal((await cancel(h,bad.task_id)).state,'interrupted');assert.ok(processIdentity(process.pid));
  const runner=path.join(h.upstream_dir,'dist/detached-runner.cjs'),markerFile=path.join(h.upstream_dir,'aw-patch.json');
  fs.appendFileSync(runner,'\n// changed\n');const marker=readJson(markerFile);marker.sha256['dist/detached-runner.cjs']=createHash('sha256').update(fs.readFileSync(runner)).digest('hex');atomicJson(markerFile,marker);
  assert.equal(checkRuntime(h.upstream_dir).available,false);assert.throws(()=>applyUpstreamPatch(h.upstream_dir),{code:'patch_conflict'});
});
test('provider boundary: Codex, OpenCode and ACP run and resume through the same task lifecycle',options,async t=>{
  for(const adapter of ['codex','opencode','acp']) {
    const {root,file}=fixture(t),config=readJson(file),binary=config.providers['claude-local'].executable;
    config.providers.fixture={adapter,executable:binary,args:adapter==='acp'?['--fixture-acp']:[],auth:'cli-managed',models:{'fixture/model':['high']},inherit_env:[]};
    config.bindings.reviewer={provider:'fixture',model:'fixture/model',effort:'high',enabled:true};atomicJson(file,config);const h=loadHost(file);
    atomicJson(path.join(root,'agent-workflow.json'),{schema_version:1,allowed_roles:['reviewer'],instructions:[],workflows:{review:'reviewer'}});
    const initial=await submit(h,{cwd:root,overrides:{workflow:'review'},raw:request('first'),requestId:'first'});
    assert.equal((await wait(h,initial.task_id,10)).state,'completed',adapter);
    const next=await submit(h,{parentId:initial.task_id,raw:request('second'),requestId:'second'});
    assert.equal((await wait(h,next.task_id,10)).state,'completed',adapter);
    assert.equal(readTask(h,next.task_id).session_id,readTask(h,initial.task_id).session_id,adapter);
    if(adapter==='acp') {
      const denied=await submit(h,{parentId:next.task_id,raw:request('write-denied'),requestId:'denied'});
      assert.equal((await wait(h,denied.task_id,10)).error,'permission_blocked');assert.equal(fs.existsSync(path.join(root,'forbidden.txt')),false);
    }
  }
});
