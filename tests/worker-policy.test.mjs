import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {deliverySchema,normalizeDelivery} from '../src/result.mjs';
import {budgetPolicy,DEFAULT_BUDGET,remainingBudget,sumCounters,exhaustedBudget} from '../src/budget.mjs';
import {telemetry,addUsage} from '../src/telemetry.mjs';
import {prepareRequest,getAdapter} from '../src/adapter.mjs';
import {loadHost,resolveRole,TOOL_ROOT} from '../src/config.mjs';
import {atomicJson,readJson,processIdentity,sameProcess,sleep} from '../src/core.mjs';
import {guardedCommand} from '../src/worker-policy.mjs';
import {filePolicy} from '../src/adapters/acp-permissions.mjs';

const report={summary:'Known defect',findings:[{severity:'blocker',location:'file:2',trigger:'zero divisor',impact:'invalid result',evidence:'missing check'}],evidence_refs:['file:2'],uncertainties:[],verdict:'fail',acceptance_checks:['static inspection'],unverified_checks:[],scope:'file'};
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aw policy 中文 & space-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('delivery: flat provider schema, lossless local wrappers, and semantic failure stays a failure',()=>{
  const schema=deliverySchema('review');assert.ok(!schema.properties.payload);assert.ok(schema.required.includes('verdict'));
  const normalized=normalizeDelivery(report,'review');assert.equal(normalized.data.payload.verdict,'fail');assert.equal(normalized.data.findings[0].severity,'blocker');
  assert.deepEqual(normalizeDelivery({parameter:report},'review').data,normalized.data);
  assert.deepEqual(normalizeDelivery({payload:normalized.data},'review').data,normalized.data);
  assert.throws(()=>normalizeDelivery({...report,verdict:'pass'},'review'),{code:'invalid_result'});
  assert.throws(()=>normalizeDelivery({parameter:report,summary:'conflicting outer data'},'review'));
  assert.throws(()=>normalizeDelivery({...report,unknown:'discard me'},'review'));
  assert.equal(normalized.delivery.aw_model_retries,0);
});
test('budgets: independent dimensions, lower-only task overrides and aggregate continuation',()=>{
  const policy=budgetPolicy({max_provider_calls:2,max_output_tokens:100});
  assert.throws(()=>budgetPolicy({max_output_tokens:101},policy,{lowerOnly:true}),{code:'budget_widened'});
  assert.throws(()=>budgetPolicy({max_model_turns:0}));assert.throws(()=>budgetPolicy({unknown:1}));
  const used=sumCounters([{provider_calls:1,output_tokens:40},{provider_calls:1,output_tokens:20}]);
  assert.equal(remainingBudget(policy,used).max_output_tokens,40);assert.equal(exhaustedBudget(policy,used),'max_provider_calls');
});
test('evidence: exact Unicode line ranges, byte limits, binary/directory rejection and escaped paths',t=>{
  const root=temporary(t),h=loadHost(path.join(TOOL_ROOT,'config/home.example.json')),snapshot=resolveRole(h,'reviewer',root);
  fs.writeFileSync(path.join(root,'evidence.txt'),'甲\n乙🙂\n丙\n');
  const raw={goal:'review',acceptance:['cite the selected line'],read_paths:['evidence.txt'],read_ranges:[{path:'evidence.txt',start_line:2,end_line:2}],budget:{max_read_bytes:8}};
  const prepared=prepareRequest(snapshot,raw);assert.equal(prepared.evidence.bytes,8);assert.match(prepared.prompt,/乙🙂/);assert.ok(!prepared.prompt.includes('甲'));
  assert.throws(()=>prepareRequest(snapshot,{...raw,read_ranges:undefined}),{code:'read_budget_exceeded'});
  fs.writeFileSync(path.join(root,'binary'),Buffer.from([0,1,2]));
  assert.throws(()=>prepareRequest(snapshot,{...raw,read_paths:['binary'],read_ranges:undefined}),{code:'evidence_not_text'});
  assert.throws(()=>prepareRequest(snapshot,{...raw,read_paths:['.'],read_ranges:undefined}),{code:'evidence_requires_files'});
  fs.symlinkSync(os.tmpdir(),path.join(root,'outside'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>prepareRequest(snapshot,{...raw,read_paths:['outside'],read_ranges:undefined}),{code:'path_not_allowed'});
  const native={...raw,read_mode:'native',read_ranges:undefined};assert.ok(!prepareRequest(snapshot,native).prompt.includes('Evidence bundle'));
});
test('every adapter disables file exploration for evidence tasks and keeps the requested model',t=>{
  const directory=temporary(t),files={directory,prompt:path.join(directory,'prompt'),schema:path.join(directory,'schema')};
  const snapshot={role:{access:'read-only',permissions:'restricted',result_contract:'review'},cwd:directory,read_mode:'evidence',model:'user-selected-model',effort:null,
    remaining_budget:DEFAULT_BUDGET,request:{read_paths:[],read_mode:'evidence',budget:DEFAULT_BUDGET}};
  for(const name of ['claude','codex','opencode','acp','dsh']) {
    const s={...snapshot,provider:{adapter:name,executable:process.execPath}},c=getAdapter(name).prepare(s,files,'existing-session');
    assert.equal(c.env.AW_WORKER,'1');
    if(name==='claude'){assert.equal(c.args[c.args.indexOf('--tools')+1],'');assert.equal(c.args[c.args.indexOf('--max-turns')+1],'24');}
    if(name==='codex'){assert.ok(c.args.includes('features.shell_tool=false'));assert.ok(c.args.includes('tools.view_image=false'));}
    if(name==='opencode'){const config=JSON.parse(c.env.OPENCODE_CONFIG_CONTENT);assert.deepEqual(config.permission,{'*':'deny'});assert.equal(config.agent['aw-readonly'].steps,24);}
    if(['acp','dsh'].includes(name)){const config=readJson(c.args[1]);assert.equal(config.read_mode,'evidence');assert.equal(config.model,s.model);assert.equal(config.session_id,'existing-session');}
    else assert.equal(c.args[c.args.indexOf('--model')+1],s.model);
  }
});
test('telemetry: streamed duplicates, failed turns, cached/thinking fields, and OpenCode step totals',()=>{
  const meter=telemetry('claude');
  const message={type:'assistant',message:{id:'one',model:'test',usage:{input_tokens:2,output_tokens:7,cache_read_input_tokens:11,output_tokens_details:{thinking_tokens:4}},content:[]}};
  meter.ingest(message);meter.ingest(message);meter.ingest({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:0.7,resetsAt:123}}}});
  assert.equal(meter.snapshot().usage.output_tokens,7);assert.equal(meter.snapshot().usage.thinking_tokens,4);assert.equal(meter.snapshot().counters.model_turns,1);assert.equal(meter.snapshot().usage_complete,false);
  const oc=telemetry('opencode');for(const [id,output] of [['a',3],['b',5],['b',5]])oc.ingest({type:'step_finish',part:{id,reason:id==='b'?'stop':'tool-calls',tokens:{input:10,output,cache:{read:2}},cost:0.01}});
  assert.equal(oc.snapshot().usage.output_tokens,8);assert.equal(oc.snapshot().estimated_cost_usd,0.02);assert.equal(oc.snapshot().usage_complete,true);
  const acp=telemetry('acp');acp.ingest({type:'aw_acp_update',update:{sessionUpdate:'usage_update',used:900,size:10000}});
  assert.equal(acp.snapshot().usage,null);assert.equal(acp.snapshot().context.used,900);assert.equal(addUsage([null,null]),null);
});
test('ACP reads: evidence denial, native allowlist, writable scope and symlink escape',t=>{
  const root=temporary(t);fs.writeFileSync(path.join(root,'allowed'),'yes');fs.writeFileSync(path.join(root,'other'),'no');
  const native=filePolicy(root,{read_paths:['allowed']});assert.equal(native.file('allowed'),path.join(root,'allowed'));
  assert.throws(()=>native.file('other'),{code:'permission_blocked'});
  const evidence=filePolicy(root,{read_paths:['allowed'],read_mode:'evidence'});assert.equal(evidence.reading,false);assert.throws(()=>evidence.file('allowed'),{code:'permission_blocked'});
});

async function runGuard(t,{adapter='claude',code,budget={},read_mode='native',contract='review'}) {
  const directory=temporary(t),prompt=path.join(directory,'prompt.txt'),script=path.join(directory,'provider.mjs');fs.writeFileSync(prompt,'task');fs.writeFileSync(script,code);
  const policy=budgetPolicy(budget),snapshot={cwd:directory,provider:{adapter},role:{result_contract:contract}},files={directory};
  const request={budget:policy,read_mode,read_paths:[]};
  const command=guardedCommand({command:process.execPath,args:[script],env:process.env,stdin_file:prompt},snapshot,files,{request});
  const child=spawn(command.command,command.args,{cwd:directory,env:process.env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill(),10000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
  const exit=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);
  return {directory,stdout,stderr,exit,usage:readJson(path.join(directory,'telemetry.json'))};
}
test('guard: model-step budget stops a real process tree and persists partial failure usage',async t=>{
  const code=`import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));let n=0;setInterval(()=>console.log(JSON.stringify({type:'assistant',message:{id:String(++n),model:'fixture',usage:{output_tokens:5},content:[]}})),80);`;
  const r=await runGuard(t,{code,budget:{max_model_turns:2}});assert.equal(r.exit,1);assert.equal(r.usage.stop_reason,'budget_exhausted:max_model_turns');
  // Windows process-tree termination has latency: count all buffered/in-flight output.
  assert.ok(r.usage.usage.output_tokens>=15);assert.equal(r.usage.usage.output_tokens,r.usage.counters.model_turns*5);assert.equal(r.usage.usage_complete,false);
  const pid=Number(fs.readFileSync(path.join(r.directory,'child.pid'),'utf8'));await sleep(150);assert.ok(!sameProcess(processIdentity(pid)));
});
test('guard: recover a rejected JSON wrapper locally before the next simulated model request',async t=>{
  const code=`import fs from 'node:fs';const emit=e=>console.log(JSON.stringify(e));emit({type:'system',subtype:'init',session_id:'same-session',model:'fixture'});emit({type:'assistant',message:{id:'one',model:'fixture',usage:{output_tokens:19},content:[{type:'tool_use',id:'report',name:'StructuredOutput',input:{parameter:${JSON.stringify(report)}}}]}});emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'report',is_error:true,content:'unexpected wrapper'}]}});setTimeout(()=>{fs.writeFileSync('unwanted-retry','called');process.exit(0)},1500);`;
  const r=await runGuard(t,{code});assert.equal(r.exit,0);assert.equal(r.usage.stop_reason,'delivery_recovered');assert.equal(fs.existsSync(path.join(r.directory,'unwanted-retry')),false);
  const log=path.join(r.directory,'stdout.log');fs.writeFileSync(log,r.stdout);const o=await getAdapter('claude').observe(log);
  assert.equal(o.final,true);assert.equal(o.error,null);assert.equal(o.session_id,'same-session');assert.equal(o.data.payload.verdict,'fail');assert.deepEqual(o.delivery.local_repairs,['unwrap:parameter']);
});
test('guard: invalid report is stopped, never promoted to accepted delivery',async t=>{
  const invalid={...report,verdict:'pass'};
  const code=`console.log(JSON.stringify({type:'assistant',message:{id:'one',model:'fixture',usage:{output_tokens:11},content:[{type:'tool_use',id:'bad',name:'StructuredOutput',input:${JSON.stringify(invalid)}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bad',is_error:true}]}}));setInterval(()=>{},1000);`;
  const r=await runGuard(t,{code});assert.equal(r.exit,1);assert.equal(r.usage.stop_reason,'invalid_result');assert.ok(!r.stdout.includes('aw_delivery'));
});
test('guard: native read escapes stop; final events without newline retain usage',async t=>{
  const code=`console.log(JSON.stringify({type:'assistant',message:{id:'one',model:'fixture',usage:{output_tokens:4},content:[{type:'tool_use',id:'read',name:'Read',input:{file_path:'not-declared'}}]}}));setInterval(()=>{},1000);`;
  const blocked=await runGuard(t,{code});assert.equal(blocked.usage.stop_reason,'read_scope_exceeded');
  const r=await runGuard(t,{adapter:'codex',code:`process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}}));`});
  assert.equal(r.exit,0);assert.equal(r.usage.usage.output_tokens,3);assert.ok(r.stdout.split('\n').filter(Boolean).every(line=>{JSON.parse(line);return true;}));
  const exceeded=await runGuard(t,{adapter:'codex',budget:{max_output_tokens:2},code:`process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}}));`});
  assert.equal(exceeded.exit,1);assert.equal(exceeded.usage.stop_reason,'budget_exhausted:max_output_tokens');assert.equal(exceeded.usage.usage.output_tokens,3);
  const recovered=await runGuard(t,{code:`console.log(JSON.stringify({type:'assistant',message:{id:'one',model:'fixture',content:[{type:'tool_use',id:'report',name:'StructuredOutput',input:{parameter:${JSON.stringify(report)}}}]}}));process.stdout.write(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'report',is_error:true}]}}));`});
  assert.equal(recovered.exit,0);assert.equal(recovered.usage.stop_reason,'delivery_recovered');assert.ok(recovered.stdout.split('\n').filter(Boolean).every(line=>{JSON.parse(line);return true;}));
});
