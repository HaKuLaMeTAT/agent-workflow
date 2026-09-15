#!/usr/bin/env node
// External CLI/protocol fixture. The task store, adapters, locks, runner and parser remain real.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],emit=e=>console.log(JSON.stringify(e));
if(args.includes('--help')){console.log('--safe-mode --restricted --tools --strict-mcp-config --setting-sources --permission-prompts --json-schema --resume --effort --ignore-user-config --ignore-rules --sandbox --output-schema --json --pure --format --variant --session --agent');process.exit(0);}
if(args.includes('--version')){console.log('fixture 1.0');process.exit(0);}
if(args[0]==='models'){console.log('fixture/model\n'+JSON.stringify({variants:{high:{}}},null,2));process.exit(0);}
if(args.includes('--input-format')) {
  createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line);emit({type:'control_response',response:{request_id:q.request_id,response:{models:['claude-sonnet-5','claude-opus-5'].map(id=>({value:id,supportedEffortLevels:['low','medium','high','max']}))}}});
  });
} else if(args.includes('--fixture-acp')) {
  let sessionId,configuration=[{id:'model',category:'model',type:'select',currentValue:'fixture/model',options:[{value:'fixture/model',name:'Fixture'}]},{id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high',name:'High'}]}];
  let pendingPrompt;
  createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line);let result;
    if(q.method==='initialize')result={protocolVersion:1,agentInfo:{version:'fixture'},agentCapabilities:{loadSession:true}};
    if(q.method==='session/new'||q.method==='session/load'){sessionId=q.params.sessionId??randomUUID();result={sessionId,configOptions:configuration};}
    if(q.method==='session/set_config_option'){configuration=configuration.map(x=>x.id===q.params.configId?{...x,currentValue:q.params.value}:x);result={configOptions:configuration};}
    if(q.method==='session/prompt') {
      const request=task(q.params.prompt[0].text);
      if(request.goal==='quota'){emit({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'usage quota reached'}});return;}
      if(request.goal==='write-denied') {
        pendingPrompt=q.id;emit({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'edit',kind:'edit',locations:[{path:'evidence.md'}]},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});return;
      }
      emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(data(request,true))}}}});result={stopReason:'end_turn'};
    }
    if(q.id==='permission') {
      if(q.result.outcome.optionId!=='reject')fs.writeFileSync('forbidden.txt','wrong permission');
      emit({jsonrpc:'2.0',id:pendingPrompt,result:{stopReason:'end_turn'}});return;
    }
    if(q.method)emit({jsonrpc:'2.0',id:q.id,result});
  });
} else {
  const request=task(fs.readFileSync(0,'utf8')),backend=args[0]==='exec'?'codex':args[0]==='run'?'opencode':'claude';
  const sessionId=args.includes('--resume')?value('--resume'):args.includes('--session')?value('--session'):args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID();
  if(backend==='claude')emit({type:'system',subtype:'init',model:value('--model'),session_id:sessionId,tools:['Read','Glob','Grep']});
  if(backend==='codex')emit({type:'thread.started',thread_id:sessionId});
  if(backend==='opencode')emit({type:'step_start',sessionID:sessionId,part:{}});
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
    const result=data(request,args.includes('--resume')||args.includes('--session')||args.includes('resume'));
    if(backend==='claude')emit({type:'result',is_error:false,session_id:sessionId,structured_output:result});
    if(backend==='codex'){emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}});emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}});}
    if(backend==='opencode'){emit({type:'text',sessionID:sessionId,part:{text:JSON.stringify(result)}});emit({type:'step_finish',sessionID:sessionId,part:{reason:'stop'}});}
  }
}
function task(prompt){return JSON.parse(prompt.match(/Task data:\n([^\n]+)/)[1]);}
function data(request,resumed){return {summary:'fixture boundary completed',findings:[],evidence_refs:[],uncertainties:[],payload:{verdict:request.goal==='incomplete'?'incomplete':'pass',acceptance_checks:['fixture protocol contract'],unverified_checks:request.goal==='incomplete'?['Critical runtime validation was not run']:[],scope:'fixture protocol only',goal:request.goal,resumed}};}
