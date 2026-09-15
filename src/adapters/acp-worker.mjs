import fs from 'node:fs';
import path from 'node:path';
import {connect,select,optionsFor} from './acp-client.mjs';
import {readJson,requireValue,within} from '../core.mjs';
import {baseObservation,parseObject,errorCode} from './common.mjs';
const o=baseObservation();let client,text='',collect=false;const calls=new Map();
const emit=()=>console.log(JSON.stringify({type:'aw_acp',observation:o}));
try {
  const config=readJson(process.argv[2]),prompt=fs.readFileSync(0,'utf8');
  client=await connect(config.provider,config.cwd,{onRead:file=>o.reads.push(file),onDenied:()=>{o.error='permission_blocked';},onUpdate:params=>{
    if(!collect)return;const u=params?.update;
    if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text')text+=u.content.text;
    if(u?.sessionUpdate==='tool_call'||u?.sessionUpdate==='tool_call_update') {
      const call={...calls.get(u.toolCallId),...u};calls.set(u.toolCallId,call);
      if(call.kind==='read'&&call.status==='completed')for(const loc of call.locations??[]) {
        const file=path.resolve(config.cwd,loc.path);if(within(config.cwd,file)&&!o.reads.includes(file))o.reads.push(file);
      }
    }
  }});
  const capabilities=client.initialized.agentCapabilities??{};
  if(config.session_id)requireValue(capabilities.loadSession===true||capabilities.sessionCapabilities?.resume,'resume_unsupported','ACP server does not advertise session continuation');
  const method=config.session_id?(capabilities.loadSession?'session/load':'session/resume'):'session/new';
  let session=await client.request(method,{...(config.session_id?{sessionId:config.session_id}:{}),cwd:config.cwd,mcpServers:[]});
  session={...session,sessionId:session.sessionId??config.session_id};o.session_id=session.sessionId;emit();
  requireValue(o.session_id,'invalid_result','ACP did not return a session handle');
  session=await select(client,session,'model',config.model);session=await select(client,session,'thought_level',config.effort);
  o.model=optionsFor(session,'model')?.currentValue??session.models?.currentModelId??null;
  o.effective_effort=optionsFor(session,'thought_level')?.currentValue??null;emit();collect=true;
  const response=await client.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:prompt}]},7200000);
  requireValue(response.stopReason==='end_turn','provider_incomplete',`ACP turn ended with ${response.stopReason}`);
  o.final=true;if(!o.error)o.data=parseObject(text);
} catch(e) {o.error=e.code==='acp_request'?errorCode(e.message):e.code??'provider_error';process.exitCode=1;}
finally {emit();if(client)await client.close();}
