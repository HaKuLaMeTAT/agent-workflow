// Explicit opt-in; one real routed file-generation task in a private non-Git directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHost} from '../src/config.mjs';
import {atomicJson,readJson,requireValue} from '../src/core.mjs';
import {routeTask} from '../src/routing.mjs';
import {submit,wait,result} from '../src/tasks.mjs';

async function main() {
  requireValue(process.argv[2]==='--run'&&process.argv.length<=4,'usage','node scripts/live-directory-smoke.mjs --run [HOST_CONFIG]; uses the routed artifact model quota');
  const configured=loadHost(process.argv[3]),directory=fs.mkdtempSync(path.join(os.tmpdir(),'aw live directory 中文-')),input=path.join(directory,'input');fs.mkdirSync(input);
  const h={...configured,state_dir:path.join(directory,'state')},selection=routeTask(h,input,{kind:'artifact',complexity:'standard'});
  requireValue(selection.action==='worker','role_unavailable','Enable routing and an external artifact role before running this acceptance');
  const nonce=randomUUID();fs.writeFileSync(path.join(input,'input.txt'),`Evidence nonce: ${nonce}\nItems: alpha, beta, gamma.\n`);
  const raw={goal:'Read input.txt. Create out/report.md with a Summary heading and the exact evidence nonce; create out/summary.json with keys nonce (copied from input) and count (number of listed items). Return implementation JSON.',acceptance:['Outputs accurately reflect the input file','Original inputs remain unchanged'],read_paths:['input.txt'],execution:{workspace:{mode:'directory'},write_paths:['out'],checks:[{type:'text',path:'out/report.md',contains:['Summary']},{type:'json',path:'out/summary.json'}],max_attempts:2},timeout_seconds:240,source:'live-directory-smoke'};
  console.log(JSON.stringify({directory,selection}));
  const task=await submit(h,{role:selection.role,cwd:input,raw,requestId:'acceptance'});console.log(JSON.stringify(task));
  let current;do{current=await wait(h,task.task_id,45);console.log(JSON.stringify(current));}while(current.wait_timed_out);
  requireValue(current.state==='completed','smoke_failed',`Task ${current.state}: ${current.error}; retained ${directory}`);
  const output=await result(h,task.task_id),report=output.execution;
  requireValue(report?.outcome==='verified'&&report.workspace_mode==='directory'&&report.patch_path===null,'smoke_failed','Expected verified directory artifacts without a patch');
  const data=readJson(path.join(report.workspace,'out/summary.json'));
  requireValue(data.nonce===nonce&&data.count===3&&fs.readFileSync(path.join(report.workspace,'out/report.md'),'utf8').includes(nonce),'smoke_failed','Output does not match the independently held input facts');
  requireValue(!fs.existsSync(path.join(input,'out'))&&!fs.existsSync(path.join(input,'.git'))&&!fs.existsSync(path.join(report.workspace,'.git')),'smoke_failed','Unexpected source changes or Git metadata');
  const record={task_id:task.task_id,dispatch:output.dispatch,platform:process.platform,workspace:report.workspace,artifacts:report.artifacts,verification:'AW text/JSON checks plus host nonce/count validation passed',report:report.report_path,limitation:'One real routing/read/write/check acceptance; not a quality or token-savings benchmark. Output retained.'};
  atomicJson(path.join(directory,'acceptance.json'),record);console.log(JSON.stringify(record,null,2));
}
main().catch(e=>{console.error(JSON.stringify({error:e.code??'smoke_error',message:e.message}));process.exitCode=1;});
