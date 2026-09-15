#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadHost,resolveRole,publicRole,TOOL_ROOT} from '../src/config.mjs';
import {discover,prepareRole} from '../src/adapter.mjs';
import {executable} from '../src/adapters/common.mjs';
import {readJson,requireValue} from '../src/core.mjs';
import {submit,status,wait,result,cancel,recover,workspaceAction} from '../src/tasks.mjs';
import {editBindings} from '../src/config-editor.mjs';
const HELP=`aw init --output FILE [--preset home|office]
aw ui [--port PORT] [--host-config FILE]  Local browser editor; loopback only
aw providers [--refresh] | models PROVIDER [--refresh]
aw roles | prepare|resolve --role ID|--workflow NAME --cwd PATH
aw configure --role ID --provider ID --model ID --effort LEVEL|--no-effort [--execution host|worker] [--write]
aw run --role ID|--workflow NAME --cwd PATH --request-file FILE --request-id ID
aw status|recover|cancel TASK | wait TASK --timeout 45 | result TASK [--cursor 0]
aw followup TASK --request-file FILE --request-id ID
aw workspace TASK | apply TASK [--write] | discard TASK [--write]
Global: --host-config FILE. JSON output. No implicit installation, fallback, or task submission.`;
try {
  const stringOptions=['host-config','role','workflow','cwd','request-file','request-id','model','effort','timeout','cursor','output','preset','provider','execution','port'];
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{...Object.fromEntries(stringOptions.map(k=>[k,{type:'string'}])),help:{type:'boolean'},refresh:{type:'boolean'},write:{type:'boolean'},'no-effort':{type:'boolean'}}});
  const command=p[0];if(v.help||command==='help'||!command){console.log(HELP);process.exit(0);}
  const allowed={ui:['port'],init:['output','preset'],providers:['cwd','refresh'],models:['cwd','refresh'],roles:[],resolve:['role','workflow','cwd','model','effort','no-effort','refresh'],prepare:['role','workflow','cwd','model','effort','no-effort','refresh'],configure:['role','provider','model','effort','no-effort','execution','write'],run:['role','workflow','cwd','model','effort','no-effort','request-file','request-id'],status:[],recover:[],wait:['timeout'],result:['cursor'],followup:['request-file','request-id'],cancel:[],workspace:[],apply:['write'],discard:['write']};
  requireValue(Object.hasOwn(allowed,command),'invalid_command',HELP);
  const positional=['models','status','recover','wait','result','followup','cancel','workspace','apply','discard'].includes(command);
  requireValue(p.length===(positional?2:1),'invalid_input',positional?'Exactly one provider/task ID required':'Unexpected positional arguments');
  for(const key of Object.keys(v))requireValue(key==='host-config'||allowed[command].includes(key),'invalid_input',`Option --${key} does not apply to ${command}`);
  if(command==='init') {
    requireValue(v.output,'invalid_input','--output is required; existing files are never overwritten');
    const preset=v.preset??'home';requireValue(['home','office'].includes(preset),'invalid_input','preset must be home or office');
    const host=readJson(path.join(TOOL_ROOT,`config/${preset}.example.json`));host.catalog=path.join(TOOL_ROOT,'config/roles.json');
    for(const [key,provider] of Object.entries(host.providers)) {
      const binary=executable(provider.adapter);provider.executable=binary??provider.adapter;
      if(!binary)for(const binding of Object.values(host.bindings))if(binding.provider===key)binding.enabled=false;
    }
    fs.writeFileSync(path.resolve(v.output),JSON.stringify(host,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({created:path.resolve(v.output),host_id:host.host_id,next:'Inspect bindings, then use providers/models/prepare. No runtime installed or global entrypoint activated.'}));process.exit(0);
  }
  requireValue(!v.effort||!v['no-effort'],'invalid_input','Use --effort or --no-effort, not both');
  const h=loadHost(v['host-config']);let output;
  if(command==='ui') {
    const {startUi}=await import('../src/ui-server.mjs');
    const ui=await startUi({hostConfig:h.hostFile,port:Number(v.port??0)});
    console.log(JSON.stringify({url:ui.url,host_config:ui.hostFile,binding:'127.0.0.1',message:'在本机浏览器打开完整链接；Ctrl+C 关闭界面。'},null,2));
    let closing=false;
    const close=()=>{if(closing)return;closing=true;ui.server.closeIdleConnections();ui.close().then(()=>process.exit(0));};
    process.on('SIGINT',close);process.on('SIGTERM',close);
    await new Promise(resolve=>ui.server.once('close',resolve));process.exit(0);
  }
  const overrides={...(v.model?{model:v.model}:{}),...(v.effort?{effort:v.effort}:{}),...(v['no-effort']?{effort:null}:{}),...(v.workflow?{workflow:v.workflow}:{})};
  if(command==='roles')output=Object.entries(h.roles).map(([role,r])=>({role,label:r.label,description:r.description,...h.bindings[role],execution:h.bindings[role]?.execution??r.execution,adapter:h.providers[h.bindings[role]?.provider]?.adapter??null}));
  if(command==='providers') {
    output=[];for(const name of Object.keys(h.providers)){
      const value=await discover(h,name,{cwd:v.cwd,refresh:v.refresh});const {models,...capabilities}=value;output.push({...capabilities,configured_model_count:models.length});
    }
  }
  if(command==='models')output=await discover(h,p[1],{cwd:v.cwd,catalog:true,refresh:v.refresh});
  if(command==='resolve'||command==='prepare') {
    const selected=await prepareRole(h,resolveRole(h,v.role,v.cwd??process.cwd(),overrides),{refresh:v.refresh});
    output={...publicRole(selected,{instructions:command==='prepare'}),next_action:selected.role.execution==='host'?'Apply these instructions in the current host; model changes require host/UI support':selected.runnable?'run with the same role/workflow and bounded request':'Resolve the reported capability/configuration issue'};
  }
  if(command==='configure') {
    requireValue(v.role&&h.roles[v.role],'invalid_input','Valid --role is required');
    const patch={enabled:true};
    for(const key of ['provider','model','effort','execution'])if(v[key]!==undefined)patch[key]=v[key];
    if(v['no-effort'])patch.effort=null;
    const edited=await editBindings(h.hostFile,{changes:[{role:v.role,patch}],write:!!v.write});
    output={written:edited.written,host_config:h.hostFile,binding:edited.configuration.bindings[v.role],configuration:!v.write?edited.configuration:undefined};
  }
  if(command==='run'||command==='followup') {
    requireValue(v['request-file']&&v['request-id'],'invalid_input','request-file and request-id required');
    output=await submit(h,{role:v.role,cwd:v.cwd??process.cwd(),raw:readJson(v['request-file']),requestId:v['request-id'],overrides,parentId:command==='followup'?p[1]:null});
  }
  if(command==='status')output=await status(h,p[1]);
  if(command==='recover')output=await recover(h,p[1]);
  if(command==='wait')output=await wait(h,p[1],Number(v.timeout??45));
  if(command==='result')output=await result(h,p[1],v.cursor===undefined?undefined:Number(v.cursor));
  if(command==='cancel')output=await cancel(h,p[1]);
  if(['workspace','apply','discard'].includes(command))output=await workspaceAction(h,p[1],command==='workspace'?'inspect':command,{write:!!v.write});
  console.log(JSON.stringify(output,null,2));
}catch(e){console.error(JSON.stringify({error:e.code??'internal_error',message:e.message}));process.exitCode=1;}
