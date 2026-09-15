// Explicit opt-in: one bounded real implementation task using an enabled executor binding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadHost} from '../src/config.mjs';
import {atomicJson,requireValue} from '../src/core.mjs';
import {git} from '../src/workspaces.mjs';
import {submit,wait,result,workspaceAction} from '../src/tasks.mjs';
import {events} from '../src/adapters/common.mjs';

async function main() {
  requireValue(process.argv[2]==='--run','usage','node scripts/live-execution-smoke.mjs --run [HOST_CONFIG] [--native-tools]; uses the enabled executor model quota');
  const args=process.argv.slice(3),native=args.includes('--native-tools'),files=args.filter(a=>a!=='--native-tools');
  requireValue(files.length<=1,'usage','Expected at most one host config');
  const configured=loadHost(files[0]);requireValue(configured.bindings.executor?.enabled,'role_unavailable','Configure and enable executor before running this acceptance test');
  requireValue(!native||configured.bindings.executor.permissions==='full-access','permission_unsupported','Native-tools acceptance requires an explicitly configured full-access executor');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aw live execute 中文-')),project=path.join(directory,'project');fs.mkdirSync(project);
  const h={...configured,state_dir:path.join(directory,'state')};
  git(project,['init']);git(project,['config','user.name','AW acceptance']);git(project,['config','user.email','aw-acceptance@example.invalid']);
  const nonce=randomUUID();fs.mkdirSync(path.join(project,'src'));
  fs.writeFileSync(path.join(project,'src/sum.mjs'),'export function sum(values) { return 0; }\nexport const evidence = "missing";\n');
  fs.writeFileSync(path.join(project,'spec.md'),`sum(values) must add its numeric inputs; an empty array returns 0. Export evidence equal to this exact nonce: ${nonce}\n`);
  fs.writeFileSync(path.join(project,'verify.mjs'),`import assert from 'node:assert/strict';import {sum,evidence} from './src/sum.mjs';assert.equal(sum([2,3]),5);assert.equal(sum([-2,7]),5);assert.equal(sum([]),0);assert.equal(evidence,${JSON.stringify(nonce)});console.log('execution acceptance passed');\n`);
  git(project,['add','.']);git(project,['commit','-m','Acceptance fixture']);
  const raw={goal:'Read spec.md, fix src/sum.mjs to satisfy it, and return implementation JSON. AW runs verify.mjs after your editing turn. Do not change tests.',acceptance:['Numeric and empty sums are correct','The evidence export matches the nonce read from spec.md','Verification remains unchanged'],read_paths:['spec.md','src/sum.mjs'],execution:{write_paths:['src/sum.mjs'],verification:[{command:process.execPath,args:['verify.mjs'],timeout_seconds:30}],max_attempts:2},source:'live-execution-smoke',timeout_seconds:240};
  if(native)raw.goal+=' Before returning, use your native command/terminal tool to run node verify.mjs yourself. Correct any failures. Report the executed check in implementation JSON.';
  const task=await submit(h,{role:'executor',cwd:project,raw,requestId:'acceptance'});console.log(JSON.stringify({task_id:task.task_id,directory,model:task.model}));
  let current;do{current=await wait(h,task.task_id,45);console.log(JSON.stringify({state:current.state,error:current.error}));}while(current.wait_timed_out);
  requireValue(current.state==='completed','smoke_failed',`Execution ${current.state}: ${current.error}; retained ${directory}`);
  const output=await result(h,task.task_id);requireValue(output.execution?.outcome==='verified','smoke_failed','Execution not verified');
  let nativeExecuted=false;
  if(native) {
    for(const attempt of output.execution.attempts)for(const e of await events(attempt.provider.stdout_path)) {
      if(e.type==='assistant'&&e.message?.content?.some(p=>p.type==='tool_use'&&['Bash','PowerShell'].includes(p.name)))nativeExecuted=true;
      if(e.type==='item.completed'&&e.item?.type==='command_execution'&&e.item.exit_code===0)nativeExecuted=true;
      if(e.type==='tool_use'&&['bash','shell','powershell'].includes(e.part?.tool)&&e.part.state?.status==='completed')nativeExecuted=true;
      if(e.type==='aw_acp'&&e.observation?.executed_commands>0)nativeExecuted=true;
    }
    requireValue(nativeExecuted,'native_command_not_observed','Implementation passed but no native command execution was observed');
  }
  requireValue(fs.readFileSync(path.join(project,'src/sum.mjs'),'utf8').includes('"missing"'),'source_changed','Source changed before apply');
  await workspaceAction(h,task.task_id,'apply',{write:true});
  const verification=execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8'}).trim();
  await workspaceAction(h,task.task_id,'discard',{write:true});
  const record={task_id:task.task_id,model:task.model,platform:process.platform,permissions:configured.bindings.executor.permissions??'restricted',native_command_observed:nativeExecuted,attempts:output.execution.attempts.length,verification,workspace_removed:true,report:output.execution.report_path,limitation:'One real read/edit/verify/apply acceptance; not a general quality, sandbox or token-savings benchmark'};
  atomicJson(path.join(directory,'acceptance.json'),record);console.log(JSON.stringify(record,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:e.code??'smoke_error',message:e.message}));process.exitCode=1;});
