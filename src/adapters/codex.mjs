import os from 'node:os';
import path from 'node:path';
import {command,environment,events,baseObservation,errorCode,parseObject,usage,permissionShape} from './common.mjs';
import {readJson} from '../core.mjs';
const required=['--ignore-user-config','--ignore-rules','--sandbox','--output-schema','--json'];
export const codex={
  id:'codex',defaultExecutable:'codex',
  async probe(provider,context) {
    const [helpOutput,versionOutput]=await Promise.all([command(provider,['exec','--help'],context),command(provider,['--version'],context)]);
    const help=helpOutput.stdout+helpOutput.stderr,version=versionOutput.stdout+versionOutput.stderr;
    const ready=required.every(flag=>help.includes(flag));let models=[],catalog_error=null;
    if(context.catalog) {
      const file=path.join(os.homedir(),'.codex/models_cache.json');
      try {
        const cache=readJson(file,8*1024*1024);
        models=(cache.models??[]).map(m=>({id:m.slug??m.id,efforts:(m.supported_reasoning_levels??[]).map(x=>x.effort??x),source:'cli_cache',verified:false})).filter(m=>typeof m.id==='string');
      }catch{catalog_error='CLI model cache unavailable; use explicit configured models';}
    }
    return {available:ready,version:version.trim(),capabilities:{read_only:ready,resume:ready,structured_output:ready,model_catalog:models.length>0},models,catalog_error,guarantee:'Codex read-only shell sandbox; MCP/delegation disabled'};
  },
  prepare(snapshot,files,sessionId) {
    permissionShape(snapshot.role.access);
    const args=[...(snapshot.provider.args??[]),'exec'];
    if(sessionId)args.push('resume',sessionId);
    args.push('--ignore-user-config','--ignore-rules','--skip-git-repo-check','--json','--output-schema',files.schema,'--model',snapshot.model,
      '-c','approval_policy="never"','-c','sandbox_mode="read-only"','-c','mcp_servers={}',
      '-c','features.multi_agent=false','-c','features.apps=false','-c','features.hooks=false','-c','web_search="disabled"');
    if(snapshot.effort!==null)args.push('-c',`model_reasoning_effort=${JSON.stringify(snapshot.effort)}`);
    args.push('-');
    return {command:snapshot.provider.executable,args,env:environment(snapshot.provider),stdin_file:files.prompt};
  },
  async observe(file) {
    const o=baseObservation();let lastMessage;
    for(const e of await events(file)) {
      if(e.type==='thread.started'){o.session_id=e.thread_id??null;o.model=e.model??null;}
      if(e.type==='item.completed'&&e.item?.type==='agent_message')lastMessage=e.item.text;
      if(e.type==='turn.completed'){o.final=true;o.usage=usage(e.usage);}
      if(e.type==='turn.failed'||e.type==='error')o.error=errorCode(e.error?.message??e.message);
    }
    if(o.final&&!o.error)try{o.data=parseObject(lastMessage);}catch(e){o.error=e.code;}
    return o;
  }
};
