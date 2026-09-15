import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connect,catalogOf} from './acp-client.mjs';
import {environment,events,baseObservation,permissionShape} from './common.mjs';
import {requireValue,atomicJson} from '../core.mjs';
export const acp={
  id:'acp',defaultExecutable:null,
  async probe(provider,context) {
    if(provider.adapter==='dsh') {
      const args=provider.args??[],index=args.indexOf('--profile'),profile=index>=0?args[index+1]:args.find(x=>x.startsWith('--profile='))?.slice(10)??'acp';
      requireValue(typeof profile==='string'&&/^[A-Za-z0-9_-]+$/.test(profile)&&!args.includes('--from-default-profile'),'profile_not_initialized','Use an explicitly initialized DSH profile');
      requireValue(fs.existsSync(path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),'profiles',profile,'package.json')),'profile_not_initialized',`Initialize the DSH ${profile} profile explicitly; probing never installs it`);
    }
    const client=await connect(provider,context.cwd);let session;
    try {
      const caps=client.initialized.agentCapabilities??{};
      if(context.catalog)session=await client.request('session/new',{cwd:context.cwd,mcpServers:[]});
      return {available:true,version:client.initialized.agentInfo?.version??null,capabilities:{read_only:true,workspace_write:true,full_access:true,resume:caps.loadSession===true||!!caps.sessionCapabilities?.resume,structured_output:false,model_catalog:!!session,catalog_authoritative:!!session},
        models:session?catalogOf(session):[],guarantee:'ACP read-only client capabilities and permission responses; agent-native tools must honor ACP permissions; not an OS sandbox',execution_guarantee:'ACP scoped file read/write and permission responses; native tools must honor permissions. AW runs verification as the OS user. Not an OS sandbox.',full_access_guarantee:'ACP file/terminal capabilities and native tool permissions enabled. Known DSH file/search/shell tools supported; unknown DSH plugins denied. Host and network access are unrestricted; not an OS sandbox.'};
    } finally {
      if(session&&client.initialized.agentCapabilities?.sessionCapabilities?.close)try{await client.request('session/close',{sessionId:session.sessionId},2000);}catch{}
      await client.close();
    }
  },
  prepare(snapshot,files,sessionId) {
    if(snapshot.role.access!=='workspace-write')permissionShape(snapshot.role.access);
    requireValue(snapshot.role.permissions!=='full-access'||snapshot.role.access==='workspace-write','permission_unsupported','Full access requires workspace-write');
    const config=path.join(files.directory,'acp-request.json');atomicJson(config,{provider:snapshot.provider,cwd:snapshot.cwd,model:snapshot.model,effort:snapshot.effort,session_id:sessionId,access:snapshot.role.access,permissions:snapshot.role.permissions,write_paths:snapshot.execution?.write_paths??[]});
    return {command:process.execPath,args:[path.join(import.meta.dirname,'acp-worker.mjs'),config],env:environment(snapshot.provider),stdin_file:files.prompt};
  },
  async observe(file) {
    const o=baseObservation();
    for(const e of await events(file))if(e.type==='aw_acp')Object.assign(o,e.observation);
    return o;
  }
};
