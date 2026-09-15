import {spawnCli as spawn,stopChild} from '../process.mjs';
import {createInterface} from 'node:readline';
import {command,environment,events,baseObservation,errorCode,parseObject,usage,permissionShape} from './common.mjs';
import {resultSchema} from '../result.mjs';
import {requireValue} from '../core.mjs';
const required=['--safe-mode','--restricted','--tools','--strict-mcp-config','--permission-prompts','--json-schema','--resume','--effort'];
const controls=['--safe-mode','--restricted','--permission-mode','plan','--permission-prompts','none','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources',''];

async function catalog(provider,cwd) {
  const child=spawn(provider.executable,[...(provider.args??[]),'--print','--input-format','stream-json','--output-format','stream-json','--verbose',...controls,'--tools',''],{cwd,env:environment(provider),stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});child.stderr.resume();
  const closed=new Promise(resolve=>child.once('close',resolve));
  let lines;
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('catalog_timeout')),8000);
      const done=(fn,value)=>{clearTimeout(timer);fn(value);};
      child.once('error',e=>done(reject,e));
      child.once('close',()=>done(reject,new Error('catalog_unavailable')));
      let bytes=0;
      lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        bytes+=line.length;if(bytes>1024*1024){done(reject,new Error('catalog_too_large'));return;}
        let item;try{item=JSON.parse(line);}catch{return;}
        if(item.type==='control_response'&&item.response?.request_id==='aw-catalog') {
          const payload=item.response.response;
          if(!Array.isArray(payload?.models)){done(reject,new Error('catalog_unavailable'));return;}
          done(resolve,payload.models.map(m=>({id:m.value??m.id,label:m.displayName??m.name,efforts:m.supportedEffortLevels??m.effortLevels??[],source:'cli_catalog',verified:true})).filter(m=>typeof m.id==='string'));
        }
      });
      child.stdin.write(JSON.stringify({type:'control_request',request_id:'aw-catalog',request:{subtype:'initialize',hooks:{},sdkMcpServers:[],agents:{},skills:[],promptSuggestions:false}})+'\n');
    });
  } finally {
    lines?.close();child.stdin.end();stopChild(child);
    const kill=setTimeout(()=>stopChild(child,'SIGKILL'),1000);await closed;clearTimeout(kill);
  }
}
export const claude={
  id:'claude',defaultExecutable:'claude',
  async probe(provider,context) {
    const [helpOutput,versionOutput]=await Promise.all([command(provider,['--help'],context),command(provider,['--version'],context)]);
    const help=helpOutput.stdout+helpOutput.stderr,version=versionOutput.stdout+versionOutput.stderr;
    const ready=required.every(flag=>help.includes(flag));let models=[],catalog_error=null;
    if(ready&&context.catalog)try{models=await catalog(provider,context.cwd);}catch(e){catalog_error=e.message;}
    const writing=ready&&['--allowedTools','--permission-mode'].every(flag=>help.includes(flag));
    return {available:ready,version:version.trim(),capabilities:{read_only:ready,workspace_write:writing,full_access:writing&&help.includes('--dangerously-skip-permissions'),verification:'aw-supervised-argv',resume:ready,structured_output:ready,model_catalog:models.length>0},models,catalog_error,guarantee:'CLI restricted file tools; not an OS sandbox',execution_guarantee:'CLI restricted file tools with scoped edit rules in the selected execution workspace; AW runs declared commands as the current OS user. No OS or network sandbox.',full_access_guarantee:'Claude permission bypass for file, shell and web tools. Customizations/MCP/delegation disabled; host and network access are unrestricted. Not an OS sandbox.'};
  },
  prepare(snapshot,files,sessionId) {
    const writing=snapshot.role.access==='workspace-write',full=snapshot.role.permissions==='full-access';
    if(!writing)permissionShape(snapshot.role.access);
    requireValue(!full||writing,'permission_unsupported','Full access requires workspace-write');
    const policy=[...controls];if(writing)policy[policy.indexOf('plan')]='dontAsk';
    if(full){policy.splice(policy.indexOf('--restricted'),1);policy[policy.indexOf('dontAsk')]='bypassPermissions';policy.push('--dangerously-skip-permissions');}
    const args=[...(snapshot.provider.args??[]),'--print','--output-format','stream-json','--verbose','--model',snapshot.model,...policy,'--tools',full?'Read,Glob,Grep,Edit,Write,Bash,PowerShell,WebFetch,WebSearch':writing?'Read,Glob,Grep,Edit,Write':'Read,Glob,Grep','--json-schema',JSON.stringify(resultSchema(snapshot.role.result_contract))];
    if(writing&&!full) {
      const rules=['Read','Glob','Grep'];
      for(const p of snapshot.execution.write_paths)for(const tool of ['Edit','Write'])rules.push(`${tool}(./${p})`,`${tool}(./${p}/**)`);
      args.push('--allowedTools',rules.join(','));
    }
    if(snapshot.effort!==null)args.push('--effort',snapshot.effort);
    if(sessionId)args.push('--resume',sessionId);
    return {command:snapshot.provider.executable,args,env:environment(snapshot.provider),stdin_file:files.prompt};
  },
  async observe(file) {
    const o=baseObservation();let final;const reads=new Map();
    for(const e of await events(file)) {
      if(e.type==='system'&&e.subtype==='init'){o.session_id=e.session_id??o.session_id;o.model=e.model??null;o.tools=e.tools??null;}
      if(e.type==='assistant')for(const part of e.message?.content??[])if(part.type==='tool_use'&&part.name==='Read'&&typeof part.input?.file_path==='string')reads.set(part.id,part.input.file_path);
      if(e.type==='user')for(const part of e.message?.content??[])if(part.type==='tool_result'&&!part.is_error&&reads.has(part.tool_use_id))o.reads.push(reads.get(part.tool_use_id));
      if(e.type==='result'){final=e;o.session_id=e.session_id??o.session_id;}
    }
    if(!final)return o;
    o.final=true;o.usage=usage(final.usage);o.estimated_cost_usd=Number.isFinite(final.total_cost_usd)?final.total_cost_usd:null;
    if(final.is_error)o.error=errorCode(final.result??final.subtype);
    else if(final.permission_denials?.length)o.error='permission_blocked';
    else try{o.data=final.structured_output??parseObject(final.result);}catch(e){o.error=e.code;}
    return o;
  }
};
