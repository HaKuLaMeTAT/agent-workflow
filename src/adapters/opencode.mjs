import path from 'node:path';
import {command,environment,events,baseObservation,errorCode,parseObject,jsonObjects,permissionShape} from './common.mjs';
const policy={'*':'deny',read:'allow',glob:'allow',grep:'allow',list:'allow',external_directory:'deny'};
function env(provider,root) {
  return {...environment(provider),XDG_CONFIG_HOME:path.join(root,'opencode-config'),OPENCODE_PURE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_LSP_DOWNLOAD:'1',OPENCODE_AUTO_SHARE:'false',
    OPENCODE_CONFIG_CONTENT:JSON.stringify({share:'disabled',plugin:[],mcp:{},permission:policy,agent:{'aw-readonly':{mode:'primary',description:'Read-only delegated task',permission:policy}}})};
}
export const opencode={
  id:'opencode',defaultExecutable:'opencode',
  async probe(provider,context) {
    const isolatedEnv=env(provider,context.probe_dir);
    const [helpOutput,versionOutput]=await Promise.all([command(provider,['run','--help'],{...context,env:isolatedEnv}),command(provider,['--version'],{...context,env:isolatedEnv})]);
    const help=helpOutput.stdout+helpOutput.stderr,version=versionOutput.stdout+versionOutput.stderr;
    const ready=['--pure','--format','--variant','--session','--agent'].every(flag=>help.includes(flag));let models=[],catalog_error=null;
    if(ready&&context.catalog)try {
      const args=['models',...(provider.catalog_filter?[provider.catalog_filter]:[]),'--verbose','--pure'];
      const {stdout}=await command(provider,args,{...context,env:isolatedEnv,maxBuffer:8*1024*1024});
      models=jsonObjects(stdout).map(({prefix,value})=>({id:prefix,efforts:Object.keys(value.variants??{}),source:'cli_catalog',verified:true})).filter(m=>m.id?.includes('/'));
      if(!models.length)catalog_error='No structured models were returned';
    }catch(e){catalog_error=e.message;}
    return {available:ready,version:version.trim(),capabilities:{read_only:ready,resume:ready,structured_output:false,model_catalog:models.length>0,catalog_authoritative:models.length>0},models,catalog_error,guarantee:'OpenCode deny-by-default tool policy; not an OS sandbox'};
  },
  prepare(snapshot,files,sessionId) {
    permissionShape(snapshot.role.access);
    const args=[...(snapshot.provider.args??[]),'run','--pure','--format','json','--agent','aw-readonly','--model',snapshot.model];
    if(snapshot.effort!==null)args.push('--variant',snapshot.effort);
    if(sessionId)args.push('--session',sessionId);
    return {command:snapshot.provider.executable,args,env:env(snapshot.provider,files.directory),stdin_file:files.prompt};
  },
  async observe(file) {
    const o=baseObservation();let text='';
    for(const e of await events(file)) {
      o.session_id=e.sessionID??o.session_id;
      if(e.type==='text')text+=e.part?.text??'';
      if(e.type==='step_start'){text='';const m=e.part?.model;if(m?.providerID&&m?.modelID)o.model=`${m.providerID}/${m.modelID}`;}
      if(e.type==='tool_use'&&e.part?.tool==='read'&&e.part.state?.status==='completed') {
        const input=e.part.state.input;const file=input?.filePath??input?.file_path;if(typeof file==='string')o.reads.push(file);
      }
      if(e.type==='tool_use'&&e.part?.state?.status==='error'&&/permission|denied|rejected/i.test(e.part.state.error??''))o.error='permission_blocked';
      if(e.type==='step_finish') {
        o.final=e.part?.reason==='stop';const t=e.part?.tokens;
        if(t)o.usage={input_tokens:t.input??null,output_tokens:t.output??null,cache_read_input_tokens:t.cache?.read??null,cache_creation_input_tokens:t.cache?.write??null};
        o.estimated_cost_usd=e.part?.cost??null;
      }
      if(e.type==='error')o.error=errorCode(e.error?.data?.message??e.error?.message??JSON.stringify(e.error));
    }
    if(o.final&&!o.error)try{o.data=parseObject(text);}catch(e){o.error=e.code;}
    return o;
  }
};
