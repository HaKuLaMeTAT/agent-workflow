import fs from 'node:fs';
import path from 'node:path';
import {emptyCounters} from './budget.mjs';
import {within} from './core.mjs';

export const TOKEN_KEYS=['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens','thinking_tokens'];
export function tokenUsage(value) {
  if(!value)return null;
  const u={...value,cache_read_input_tokens:value.cache_read_input_tokens??value.cached_input_tokens,
    thinking_tokens:value.thinking_tokens??value.output_tokens_details?.thinking_tokens??value.reasoning_output_tokens};
  return Object.fromEntries(TOKEN_KEYS.map(k=>[k,Number.isFinite(u[k])&&u[k]>=0?u[k]:null]));
}
export function addUsage(values) {
  if(!values.some(Boolean))return null;
  return Object.fromEntries(TOKEN_KEYS.map(k=>{const v=values.map(u=>u?.[k]).filter(Number.isFinite);return [k,v.length?v.reduce((a,b)=>a+b,0):null];}));
}
export function readAccess(file,scope) {
  if(!scope)return {allowed:true,missing:false};
  try {
    let ancestor=path.resolve(scope.cwd,file);const missing=[];
    for(;;) {
      // lstat sees dangling links; never treat an unresolved link as absent.
      try {fs.lstatSync(ancestor);break;}catch(e) {
        if(e.code!=='ENOENT'||path.dirname(ancestor)===ancestor)throw e;
        missing.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);
      }
    }
    const canonical=fs.realpathSync(ancestor);
    if(missing.length&&!fs.statSync(canonical).isDirectory())return {allowed:false,missing:false};
    const target=path.join(canonical,...missing);
    return {allowed:scope.paths.some(p=>path.relative(p.path,target)===''||(p.directory&&within(p.path,target))),missing:missing.length>0};
  }catch{return {allowed:false,missing:false};}
}
export function allowedRead(file,scope) {return readAccess(file,scope).allowed;}
// Count observed provider events, not guesses about unreported API requests.
export function telemetry(adapter,{scope}={}) {
  const messages=new Map(),steps=new Map(),tools=new Map(),modelSteps=new Set(),readResults=new Set();
  let finalUsage=null,complete=false,cost=null,quota=null,session=null,scopeError=null,toolError=null,missingRead=null,readBytes=0,largestRead=0,formatErrors=0,context=null;
  const recordRead=(id,value)=>{if(readResults.has(id))return;readResults.add(id);const bytes=typeof value==='number'?value:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??''));readBytes+=bytes;largestRead=Math.max(largestRead,bytes);};
  function trackTool(id,name,input={}) {
    if(!id)return;
    const prior=tools.get(id);tools.set(id,{name,input:{...prior?.input,...input}});
    if(scope?.mode==='evidence'&&name!=='StructuredOutput')scopeError={code:['Read','read','Glob','glob','Grep','grep','list'].includes(name)?'read_scope_exceeded':'permission_blocked',tool:name};
    const file=input.file_path??input.filePath??input.path;
    if(scope&&['Read','read','read_image','Glob','glob','Grep','grep','list'].includes(name)) {
      const access=typeof file==='string'?readAccess(file,scope):{allowed:false};
      if(scope.mode==='evidence'||!access.allowed)scopeError??={code:'read_scope_exceeded',tool:name,path:file??null};
      else if(access.missing)missingRead??={code:'read_target_missing',tool:name,path:file};
    }
  }
  function ingest(e) {
    if(e.type==='rate_limit_event')quota=e.rate_limit_info??quota;
    if(e.type==='system'&&e.subtype==='init')session=e.session_id??session;
    if(e.type==='thread.started')session=e.thread_id??session;
    if(e.sessionID)session=e.sessionID;
    if(adapter==='claude') {
      if(e.type==='assistant'&&e.message&&e.message.model!=='<synthetic>') {
        const m=e.message,id=m.id;
        if(id){modelSteps.add(id);const u=tokenUsage(m.usage),prior=messages.get(id);if(u)messages.set(id,Object.fromEntries(TOKEN_KEYS.map(k=>[k,u[k]===null?prior?.[k]??null:Math.max(prior?.[k]??0,u[k])])));}
        for(const p of m.content??[])if(p.type==='tool_use')trackTool(p.id,p.name,p.input);
      }
      if(e.type==='user')for(const p of Array.isArray(e.message?.content)?e.message.content:[])if(p.type==='tool_result'&&!readResults.has(p.tool_use_id)) {
        const t=tools.get(p.tool_use_id);
        if(t?.name==='StructuredOutput'&&p.is_error)formatErrors++;
        if(['Read','Glob','Grep'].includes(t?.name))recordRead(p.tool_use_id,p.content);else readResults.add(p.tool_use_id);
      }
      if(e.type==='result'){finalUsage=tokenUsage(e.usage)??finalUsage;complete=!!e.usage;cost=e.total_cost_usd??cost;}
    }else if(adapter==='codex') {
      if(e.type==='item.completed'&&e.item?.type==='agent_message')modelSteps.add(e.item.id??`message-${modelSteps.size}`);
      if(['item.started','item.completed'].includes(e.type)&&['command_execution','mcp_tool_call','file_change','web_search'].includes(e.item?.type)) {
        trackTool(e.item.id??`item-${tools.size}`,e.item.type,e.item);
        if(scope?.mode==='evidence')scopeError={code:'read_scope_exceeded',tool:e.item.type};
        if(e.type==='item.completed'&&e.item.type==='command_execution')recordRead(e.item.id??`command-${readResults.size}`,e.item.aggregated_output??'');
      }
      if(e.type==='turn.completed'){finalUsage=tokenUsage(e.usage);complete=!!e.usage;}
    }else if(adapter==='opencode') {
      if(e.type==='step_start')modelSteps.add(e.part?.id??`step-${modelSteps.size}`);
      if(e.type==='tool_use') {
        const p=e.part??{};
        if(p.state?.status==='error'&&/permission|denied|rejected/i.test(p.state.error??''))toolError??={code:'permission_blocked',tool:p.tool};
        trackTool(p.callID??p.id,p.tool,p.state?.input);
        if(p.state?.status==='completed'&&['read','glob','grep','list'].includes(p.tool)&&!readResults.has(p.callID??p.id)) {
          recordRead(p.callID??p.id,p.state.output??'');
        }
      }
      if(e.type==='step_finish') {
        const t=e.part?.tokens;if(t)steps.set(e.part.id??`finish-${steps.size}`,{usage:tokenUsage({input_tokens:t.input,output_tokens:t.output,thinking_tokens:t.reasoning,cache_read_input_tokens:t.cache?.read,cache_creation_input_tokens:t.cache?.write}),cost:e.part.cost});
        if(e.part?.reason==='stop')complete=steps.size>0;
      }
    }else if(['acp','dsh'].includes(adapter)) {
      if(e.type==='aw_acp_update') {
        const u=e.update;
        if(u.sessionUpdate==='usage_update')context={used:u.used,size:u.size,cost:u.cost??null};
        if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update') {
          tools.set(u.toolCallId,{name:u.title,input:u.rawInput});
          if(scope?.mode==='evidence')scopeError={code:['read','search'].includes(u.kind)?'read_scope_exceeded':'permission_blocked',tool:u.title??'acp_tool'};
        }
        if(u.sessionUpdate==='agent_message_chunk'&&u.new_response)modelSteps.add(u.response_id);
      }
      if(e.type==='aw_read')recordRead(e.id??`read-${readResults.size}`,e.bytes??0);
      if(e.type==='aw_acp') {
        session=e.observation.session_id??session;
        if(e.observation.usage){finalUsage=tokenUsage(e.observation.usage);complete=!!e.observation.final;}
      }
    }
  }
  function snapshot() {
    const usage=finalUsage??addUsage(adapter==='opencode'?[...steps.values()].map(v=>v.usage):[...messages.values()]);
    const counters={...emptyCounters(),model_turns:modelSteps.size,tool_calls:tools.size,output_tokens:usage?.output_tokens??0,read_bytes:readBytes};
    const costs=[...steps.values()].map(v=>v.cost).filter(Number.isFinite);
    return {usage,usage_complete:complete,usage_source:finalUsage?'provider_final':steps.size?'provider_steps':messages.size?'partial_messages':'unreported',
      counters,counters_are_observed_lower_bounds:true,model_turns_scope:adapter==='codex'?'visible_agent_messages':adapter==='acp'||adapter==='dsh'?'visible_response_blocks':'observed_model_steps',
      estimated_cost_usd:cost??(costs.length?costs.reduce((a,b)=>a+b,0):null),quota,context,session_id:session,scope_error:scopeError,tool_error:toolError,missing_read:missingRead,largest_read_bytes:largestRead,format_errors:formatErrors};
  }
  return {ingest,snapshot};
}
export function aggregateTelemetry(values) {
  const present=values.filter(Boolean);
  return {usage:addUsage(present.map(v=>v.usage)),usage_complete:present.length>0&&present.every(v=>v.usage_complete),
    estimated_cost_usd:present.some(v=>Number.isFinite(v.estimated_cost_usd))?present.reduce((sum,v)=>sum+(v.estimated_cost_usd??0),0):null,
    quota:present.findLast(v=>v.quota)?.quota??null};
}
