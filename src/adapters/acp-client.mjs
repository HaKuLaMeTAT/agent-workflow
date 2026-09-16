import path from 'node:path';
import fs from 'node:fs';
import {spawnCli as spawn,stopChild} from '../process.mjs';
import {createInterface} from 'node:readline';
import {AwError,requireValue,readText} from '../core.mjs';
import {environment} from './common.mjs';
import {filePolicy,classifyCall} from './acp-permissions.mjs';
import {terminals} from './acp-terminals.mjs';

// Small ACP JSON-RPC transport; no daemon and no SDK dependency.
export async function connect(provider,cwd,{onUpdate=()=>{},onRead=()=>{},onDenied=()=>{},timeout=15000,budget,...permissions}={}) {
  const policy=filePolicy(cwd,permissions),calls=new Map(),terminal=terminals(provider,cwd);
  let readBytes=0;
  const child=spawn(provider.executable,provider.args??[],{cwd,env:environment(provider),stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});child.stderr.resume();const pending=new Map();let next=0,bytes=0;
  const closed=new Promise(resolve=>child.once('close',resolve));
  const failAll=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',()=>failAll(new AwError('acp_transport','ACP process could not start')));
  child.on('close',()=>failAll(new AwError('acp_transport','ACP process closed')));
  const write=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  const lines=createInterface({input:child.stdout});
  lines.on('line',async line=>{
    bytes+=line.length;if(bytes>16*1024*1024||line.length>2*1024*1024){failAll(new AwError('output_too_large','ACP output limit exceeded'));stopChild(child);return;}
    let message;try{message=JSON.parse(line);}catch{return;}
    if(message.method) {
      if(message.id===undefined){if(message.method==='session/update'){
        const p=message.params,u=p?.update,key=`${p?.sessionId}:${u?.toolCallId}`;
        if(['tool_call','tool_call_update'].includes(u?.sessionUpdate))calls.set(key,{...calls.get(key),...u});
        onUpdate(p);
      }return;}
      let result;
      try {
        if(message.method==='session/request_permission') {
          const p=message.params,partial=p.toolCall,call=classifyCall({...calls.get(`${p.sessionId}:${partial.toolCallId}`),...partial},provider.adapter,cwd);
          const allowed=policy.allows(call),option=p.options?.find(x=>x.kind===(allowed?'allow_once':'reject_once'));
          if(!allowed)onDenied(call);
          result={outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}};
        } else if(message.method==='fs/read_text_file') {
          const p=message.params,file=policy.file(p.path),content=readText(file,budget?.max_read_bytes??1024*1024);
          requireValue((p.line===undefined||Number.isInteger(p.line)&&p.line>=1)&&(p.limit===undefined||Number.isInteger(p.limit)&&p.limit>=0),'permission_blocked','Invalid line range');
          result={content:p.line===undefined&&p.limit===undefined?content:content.split('\n').slice((p.line??1)-1,p.limit===undefined?undefined:(p.line??1)-1+p.limit).join('\n')};
          const bytes=Buffer.byteLength(result.content);readBytes+=bytes;
          requireValue(readBytes<=(budget?.max_total_read_bytes??16*1024*1024),'read_budget_exceeded','ACP read budget exceeded');onRead(file,bytes);
        } else if(message.method==='fs/write_text_file') {
          const p=message.params,file=policy.file(p.path,{write:true});
          requireValue(typeof p.content==='string'&&Buffer.byteLength(p.content)<=1024*1024,'permission_blocked','Invalid or oversized file content');
          fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,p.content);result=null;
        } else if(message.method.startsWith('terminal/')&&policy.full) {
          result=await terminal.handle(message.method,message.params);
        } else throw new AwError('permission_blocked','Client method is not allowed');
        write({id:message.id,result});
      }catch{onDenied({kind:message.method});write({id:message.id,error:{code:-32601,message:'Client capability denied'}});}
      return;
    }
    const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);
    if(message.error)p.reject(new AwError('acp_request',String(message.error.message??'ACP request failed')));else p.resolve(message.result);
  });
  const request=(method,params,deadline=timeout)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new AwError('acp_timeout',`ACP ${method} timed out`));},deadline);
    pending.set(id,{resolve,reject,timer});write({id,method,params});
  });
  const close=async()=>{
    failAll(new AwError('acp_closed','ACP client closed'));lines.close();child.stdin.end();stopChild(child);
    await terminal.close();
    const timer=setTimeout(()=>stopChild(child,'SIGKILL'),1000);await closed;clearTimeout(timer);
  };
  try {
    const initialized=await request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:policy.reading,writeTextFile:policy.writing},terminal:policy.full},clientInfo:{name:'agent-workflow',version:'0.4.5'}});
    requireValue(initialized.protocolVersion===1,'unsupported_protocol','ACP protocol version is unsupported');
    return {request,close,initialized};
  }catch(e){await close();throw e;}
}
export function optionsFor(session,category) {
  return (session.configOptions??[]).find(x=>x.category===category||(category==='thought_level'&&x.id==='reasoning_effort')||(category==='model'&&x.id==='model'));
}
export function values(option) {return (option?.options??[]).flatMap(x=>x.options??[x]);}
export function catalogOf(session) {
  const efforts=values(optionsFor(session,'thought_level')).map(x=>x.value);
  const models=session.models?.availableModels?.map(m=>({id:m.modelId,label:m.name}))??values(optionsFor(session,'model')).map(m=>({id:m.value,label:m.name}));
  return models.map(m=>({...m,efforts,source:'acp_session',verified:true}));
}
export async function select(client,session,category,value) {
  if(value===null)return session;
  const option=optionsFor(session,category);
  if(option) {
    requireValue(values(option).some(x=>x.value===value),category==='model'?'unsupported_model':'unsupported_effort',`ACP does not advertise ${category} ${value}`);
    const response=await client.request('session/set_config_option',{sessionId:session.sessionId,configId:option.id,value});
    // Never report a requested value as an acknowledged effective value.
    const next={...session,...response};requireValue(optionsFor(next,category)?.currentValue===value,'unverified_selection',`ACP did not confirm ${category}`);return next;
  }
  if(category==='model'&&session.models?.availableModels?.some(m=>m.modelId===value)) {
    await client.request('session/set_model',{sessionId:session.sessionId,modelId:value});
    return {...session,models:{...session.models,currentModelId:value}};
  }
  throw new AwError(category==='model'?'unsupported_model':'unsupported_effort',`ACP does not expose ${category} selection`);
}
