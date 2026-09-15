import fs from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {spawnCli,stopChild} from './process.mjs';
import {readJson,atomicJson} from './core.mjs';
import {telemetry} from './telemetry.mjs';
import {exhaustedBudget} from './budget.mjs';
import {normalizeDelivery} from './result.mjs';

const plan=readJson(process.argv[2],4*1024*1024),meter=telemetry(plan.adapter,{scope:plan.scope});
let child,reason=null,bytes=0,buffer='',lastSave=0,closed=false,killTimer;
const start=Date.now(),decoder=new StringDecoder('utf8');
const deliveries=new Map();
function snapshot(){const t=meter.snapshot();t.counters.provider_calls=child?.pid?1:0;t.counters.duration_seconds=(Date.now()-start)/1000;t.counters.read_bytes+=plan.evidence_bytes??0;return {...t,budget:plan.budget,stop_reason:reason,updated_at:new Date().toISOString()};}
function persist(force=false){if(force||Date.now()-lastSave>200){atomicJson(plan.telemetry_file,snapshot());lastSave=Date.now();}}
function stopTree(signal='SIGTERM') {
  if(process.platform==='linux'&&child?.pid){try{process.kill(-child.pid,signal);}catch{stopChild(child,signal);}}
  else if(child)stopChild(child,signal);
}
function stop(code){if(reason)return;reason=code;persist(true);if(closed)return;stopTree();killTimer=setTimeout(()=>stopTree('SIGKILL'),500);}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop('interrupted'));
function event(line) {
  let e;try{e=JSON.parse(line);}catch{return;}
  meter.ingest(e);const current=snapshot();
  if(e.type==='aw_acp'&&e.observation?.error)stop(e.observation.error);
  if(current.scope_error)stop(current.scope_error.code);
  if(current.largest_read_bytes>plan.budget.max_read_bytes)stop('read_budget_exceeded');
  // End the current call once observable work exceeds a cap. A CLI may report
  // usage only after a request finishes; the meter never claims pre-request billing control.
  const hit=exhaustedBudget(Object.fromEntries(Object.entries({...plan.budget,max_provider_calls:Infinity}).map(([k,v])=>[k,v+1])),current.counters);
  if(hit)stop('budget_exhausted:'+hit);
  if(plan.adapter==='claude') {
    if(e.type==='assistant')for(const p of e.message?.content??[])if(p.type==='tool_use'&&p.name==='StructuredOutput')deliveries.set(p.id,p.input);
    if(e.type==='user')for(const p of Array.isArray(e.message?.content)?e.message.content:[])if(p.type==='tool_result'&&p.is_error&&deliveries.has(p.tool_use_id)&&!reason) {
      try {
        const delivery=normalizeDelivery(deliveries.get(p.tool_use_id),plan.contract);
        process.stdout.write(JSON.stringify({type:'aw_delivery',...delivery})+'\n');stop('delivery_recovered');
      }catch{stop('invalid_result');}
    }
  }
  persist();
}
persist(true);
try {
  const c=plan.command,input=fs.openSync(c.stdin_file,'r');
  try{child=spawnCli(c.command,c.args,{cwd:c.cwd,env:c.env,detached:process.platform==='linux',stdio:[input,'pipe','pipe']});}finally{fs.closeSync(input);}
  child.on('error',()=>{reason??='command_launch_failed';});
  child.stdout.on('data',chunk=>{
    bytes+=chunk.length;if(bytes>16*1024*1024){stop('output_too_large');return;}
    process.stdout.write(chunk);buffer+=decoder.write(chunk);
    if(Buffer.byteLength(buffer)>2*1024*1024){stop('output_too_large');return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);event(line);}
  });
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024)stop('output_too_large');else process.stderr.write(chunk);});
  const timer=setInterval(()=>{if((Date.now()-start)/1000>=plan.budget.max_duration_seconds)stop('budget_exhausted:max_duration_seconds');persist();},200);
  child.once('exit',()=>stopTree('SIGKILL'));
  const code=await new Promise(resolve=>child.once('close',code=>resolve(code)));
  closed=true;clearInterval(timer);clearTimeout(killTimer);
  buffer+=decoder.end();if(buffer.trim()){process.stdout.write('\n');event(buffer);}persist(true);
  process.stdout.write(JSON.stringify({type:'aw_telemetry',telemetry:snapshot()})+'\n');
  process.exitCode=reason==='delivery_recovered'?0:reason?1:code??1;
}catch(e){reason??=e.code??'guard_failed';persist(true);process.exitCode=1;}
