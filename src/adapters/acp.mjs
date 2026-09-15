import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connect,catalogOf} from './acp-client.mjs';
import {environment,events,baseObservation,permissionShape} from './common.mjs';
import {requireValue,atomicJson} from '../core.mjs';
export const acp={
  id:'acp',defaultExecutable:null,
  async probe(provider,context) {
    if(provider.adapter==='dsh')requireValue(fs.existsSync(path.join(os.homedir(),'.dsh/profiles/acp/package.json')),'profile_not_initialized','Initialize the DSH acp profile explicitly; probing never installs it');
    const client=await connect(provider,context.cwd);let session;
    try {
      const caps=client.initialized.agentCapabilities??{};
      if(context.catalog)session=await client.request('session/new',{cwd:context.cwd,mcpServers:[]});
      return {available:true,version:client.initialized.agentInfo?.version??null,capabilities:{read_only:true,resume:caps.loadSession===true||!!caps.sessionCapabilities?.resume,structured_output:false,model_catalog:!!session,catalog_authoritative:!!session},
        models:session?catalogOf(session):[],guarantee:'ACP read-only client capabilities and permission responses; agent-native tools must honor ACP permissions; not an OS sandbox'};
    } finally {
      if(session&&client.initialized.agentCapabilities?.sessionCapabilities?.close)try{await client.request('session/close',{sessionId:session.sessionId},2000);}catch{}
      await client.close();
    }
  },
  prepare(snapshot,files,sessionId) {
    permissionShape(snapshot.role.access);
    const config=path.join(files.directory,'acp-request.json');atomicJson(config,{provider:snapshot.provider,cwd:snapshot.cwd,model:snapshot.model,effort:snapshot.effort,session_id:sessionId});
    return {command:process.execPath,args:[path.join(import.meta.dirname,'acp-worker.mjs'),config],env:environment(snapshot.provider),stdin_file:files.prompt};
  },
  async observe(file) {
    const o=baseObservation();
    for(const e of await events(file))if(e.type==='aw_acp')Object.assign(o,e.observation);
    return o;
  }
};
