#!/usr/bin/env node
// External CLI/protocol fixture. The task store, adapters, locks, runner and parser remain real.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],emit=e=>console.log(JSON.stringify(e));
if(args.includes('--help')){console.log('--dangerously-skip-permissions --safe-mode --restricted --tools --allowedTools --permission-mode --strict-mcp-config --setting-sources --permission-prompts --json-schema --resume --effort --ignore-user-config --ignore-rules --sandbox --output-schema --json --pure --format --variant --session --agent');process.exit(0);}
if(args.includes('--version')){console.log('fixture 1.0');process.exit(0);}
if(args[0]==='models'){console.log('fixture/model\n'+JSON.stringify({variants:{high:{}}},null,2));process.exit(0);}
if(args.includes('--input-format')) {
  createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line);emit({type:'control_response',response:{request_id:q.request_id,response:{models:['claude-sonnet-5','claude-opus-5'].map(id=>({value:id,supportedEffortLevels:['low','medium','high','max']}))}}});
  });
} else if(args.includes('--fixture-acp')) {
  let sessionId,resumed=false,capabilities,configuration=[{id:'model',category:'model',type:'select',currentValue:'fixture/model',options:[{value:'fixture/model',name:'Fixture'}]},{id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high',name:'High'}]}];
  const replies=new Map();let serial=0;
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=`client-${++serial}`;replies.set(id,{resolve,reject});emit({jsonrpc:'2.0',id,method,params:{sessionId,...params}});});
  const update=u=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:u}});
  async function permission(kind,file,title='write',rawInput={file_path:file}) {
    const toolCallId=`tool-${++serial}`,call=args.includes('--fixture-dsh')?{toolCallId,kind:'other',title,rawInput}:{toolCallId,kind,locations:[{path:file}]};
    update({sessionUpdate:'tool_call',...call,status:'in_progress'});
    const reply=await rpc('session/request_permission',{toolCall:{toolCallId},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]});
    return reply.outcome.optionId==='allow';
  }
  createInterface({input:process.stdin}).on('line',async line=>{
    const q=JSON.parse(line);let result;
    if(!q.method){const pending=replies.get(q.id);replies.delete(q.id);if(q.error)pending?.reject(new Error(q.error.message));else pending?.resolve(q.result);return;}
    try {
      if(q.method==='initialize'){capabilities=q.params.clientCapabilities;result={protocolVersion:1,agentInfo:{name:'fixture',version:'fixture'},agentCapabilities:{loadSession:true}};}
      if(q.method==='session/new'||q.method==='session/load'){resumed=!!q.params.sessionId;sessionId=q.params.sessionId??randomUUID();result={sessionId,configOptions:configuration};}
      if(q.method==='session/set_config_option'){configuration=configuration.map(x=>x.id===q.params.configId?{...x,currentValue:q.params.value}:x);result={configOptions:configuration};}
      if(q.method==='session/prompt') {
        const request=task(q.params.prompt[0].text);
        if(request.goal==='quota')throw new Error('usage quota reached');
        if(request.goal==='write-denied') {
          if(await permission('edit','evidence.md'))fs.writeFileSync('forbidden.txt','wrong permission');
        }else if(request.execution?.workspace?.mode==='directory') {
          if(!capabilities.fs.writeTextFile)throw new Error('Missing writable client capability');
          const input=fs.existsSync('input.txt')?(await rpc('fs/read_text_file',{path:path.resolve('input.txt')})).content:'generated';
          for(const [name,content] of directoryContents(request,resumed,input)) {
            const file=path.resolve(name);if(!await permission('edit',file))throw new Error('directory write denied');
            await rpc('fs/write_text_file',{path:file,content});
          }
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(implementation(input))}});
        }else if(request.execution) {
          if(!capabilities.fs.writeTextFile)throw new Error('Missing writable client capability');
          const before=(await rpc('fs/read_text_file',{path:path.resolve('src/math.mjs')})).content;
          const file=path.resolve('src/math.mjs');
          if(!await permission('edit',file))throw new Error('edit denied');
          await rpc('fs/write_text_file',{path:file,content:`export const add = (a, b) => ${request.goal!=='execute-fix'||resumed?'a + b':'a - b'};\n`});
          if(!await permission('edit',path.resolve('src/new.bin')))throw new Error('create denied');
          fs.writeFileSync('src/new.bin',Buffer.from([0,1,2,255]));
          if(fs.existsSync('src/remove.txt')){
            if(!await permission('delete',path.resolve('src/remove.txt'),'edit',{file_path:path.resolve('src/remove.txt')}))throw new Error('delete denied');
            fs.unlinkSync('src/remove.txt');
          }
          if(capabilities.terminal) {
            const {terminalId}=await rpc('terminal/create',{command:process.execPath,args:['-e','console.log("native terminal verified")'],cwd:process.cwd()});
            const exit=await rpc('terminal/wait_for_exit',{terminalId}),out=await rpc('terminal/output',{terminalId});
            if(exit.exitCode!==0||!out.output.includes('native terminal verified'))throw new Error('Native terminal failed');
            await rpc('terminal/release',{terminalId});
          }
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(implementation(before))}});
        }else update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(data(request,resumed))}});
        result={stopReason:'end_turn'};
      }
      emit({jsonrpc:'2.0',id:q.id,result});
    }catch(e){emit({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:e.message}});}
  });
} else {
  const request=task(fs.readFileSync(0,'utf8')),backend=args[0]==='exec'?'codex':args[0]==='run'?'opencode':'claude';
  const sessionId=args.includes('--resume')?value('--resume'):args.includes('--session')?value('--session'):args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID();
  if(backend==='claude')emit({type:'system',subtype:'init',model:value('--model'),session_id:sessionId,tools:['Read','Glob','Grep']});
  if(backend==='codex')emit({type:'thread.started',thread_id:sessionId});
  if(backend==='opencode')emit({type:'step_start',sessionID:sessionId,part:{}});
  if(request.goal==='orphan') {
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync('descendant.pid',String(descendant.pid));descendant.unref();
  }
  if(request.goal==='hang') {
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync('descendant.pid',String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  }else if(request.goal==='invalid-result')console.log('no final result');
  else if(request.goal==='quota') {
    if(backend==='claude')emit({type:'result',is_error:true,result:'usage quota reached',session_id:sessionId});
    if(backend==='codex')emit({type:'turn.failed',error:{message:'usage quota reached'}});
    if(backend==='opencode')emit({type:'error',sessionID:sessionId,error:{message:'usage quota reached'}});
    process.exitCode=1;
  }else {
    if(request.execution?.workspace?.mode==='directory') {
      const input=fs.existsSync('input.txt')?fs.readFileSync('input.txt','utf8'):'generated';
      const resumed=args.includes('--resume')||args.includes('--session')||args.includes('resume');
      for(const [name,content] of directoryContents(request,resumed,input)){fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,content);}
      if(request.goal==='directory-outside')fs.writeFileSync('untouched.txt','outside change');
      nativeResult(backend,sessionId,implementation(input));process.exit(0);
    }
    if(request.execution) {
      if(backend==='claude'&&!args.includes('--dangerously-skip-permissions')&&(value('--tools')!=='Read,Glob,Grep,Edit,Write'||value('--permission-mode')!=='dontAsk'||!value('--allowedTools').includes('Edit(./src/**)')))throw new Error('Missing scoped editing policy');
      if(backend==='codex'&&!args.includes('sandbox_mode="workspace-write"')&&!args.includes('sandbox_mode="danger-full-access"'))throw new Error('Missing writable sandbox');
      if(backend==='opencode') {
        const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),policy=config.agent['aw-executor']?.permission;
        if(value('--agent')!=='aw-executor'||!(policy?.edit?.['src/*']==='allow'||policy?.['*']==='allow'))throw new Error('Missing edit permissions');
      }
      const before=fs.readFileSync('src/math.mjs','utf8');
      const corrected=request.goal!=='execute-fix'||args.includes('--resume')||args.includes('--session')||args.includes('resume');
      fs.writeFileSync('src/math.mjs',`export const add = (a, b) => ${corrected?'a + b':'a - b'};\n`);
      fs.writeFileSync('src/new.bin',Buffer.from([0,1,2,255]));
      if(fs.existsSync('src/remove.txt'))fs.unlinkSync('src/remove.txt');
      if(request.goal==='execute-outside')fs.writeFileSync('outside.txt','outside scope');
      nativeResult(backend,sessionId,implementation(before));
      process.exit(0);
    }
    const result=data(request,args.includes('--resume')||args.includes('--session')||args.includes('resume'));
    nativeResult(backend,sessionId,result);
  }
}
function task(prompt){return JSON.parse(prompt.match(/Task data:\n([^\n]+)/)[1]);}
function data(request,resumed){return {summary:'fixture boundary completed',findings:[],evidence_refs:[],uncertainties:[],payload:{verdict:request.goal==='incomplete'?'incomplete':'pass',acceptance_checks:['fixture protocol contract'],unverified_checks:request.goal==='incomplete'?['Critical runtime validation was not run']:[],scope:'fixture protocol only',goal:request.goal,resumed}};}

function implementation(before){return {summary:'Implementation prepared for AW verification',findings:[],evidence_refs:['src/math.mjs'],uncertainties:[],payload:{scope:'src',changes:[before.trim()],verification:['AW verification pending'],limitations:[]}};}
function nativeResult(backend,sessionId,result) {
  if(backend==='claude')emit({type:'result',is_error:false,session_id:sessionId,structured_output:result,usage:{input_tokens:2,output_tokens:3},total_cost_usd:0.01});
  if(backend==='codex'){emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}});emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}});}
  if(backend==='opencode'){emit({type:'text',sessionID:sessionId,part:{text:JSON.stringify(result)}});emit({type:'step_finish',sessionID:sessionId,part:{reason:'stop'}});}
}

function directoryContents(request,resumed,input) {
  const good=request.goal!=='directory-fix'||resumed;
  return [['out/report.md',input+'\nDocument generated.\n'],['out/result.json',good?JSON.stringify({source:input,ok:true}):'{incomplete']];
}
