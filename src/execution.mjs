import fs from 'node:fs';
import path from 'node:path';
import {fields,strings,text,integer,requireValue,within,real} from './core.mjs';
import {executable,events,baseObservation} from './adapters/common.mjs';

export function relativePath(value,label,{dot=false}={}) {
  text(value,label,2000);
  if(dot&&value==='.')return value;
  requireValue(!path.isAbsolute(value)&&!/[\\:*?\[\](),\x00-\x1f\x7f]/.test(value)&&value.split('/').every(p=>p&&p!=='..'&&p!=='.'&&!/^\.git$/i.test(p)&&!/[. ]$/.test(p)),'invalid_input',`${label} must be a relative literal path using /, without wildcards, rule syntax, .. or .git`);
  return value;
}
export function executionRequest(snapshot,raw) {
  fields(raw,['write_paths','setup','verification','max_attempts'],'execution');
  strings(raw.write_paths,'write_paths');requireValue(raw.write_paths.length>0,'invalid_input','Execution requires write_paths');
  const write_paths=raw.write_paths.map(p=>relativePath(p,'write_paths'));
  requireValue(Array.isArray(raw.verification)&&raw.verification.length>0&&raw.verification.length<=12,'invalid_input','Execution requires 1..12 verification commands');
  requireValue(Array.isArray(raw.setup??[])&&(raw.setup??[]).length<=8,'invalid_input','setup must contain at most 8 commands');
  const normalize=(v,i)=>{
    fields(v,['command','args','cwd','timeout_seconds'],`verification[${i}]`);text(v.command,'command',2000);
    requireValue(Array.isArray(v.args)&&v.args.length<=100,'invalid_input','args must contain at most 100 strings');
    v.args.forEach(a=>requireValue(typeof a==='string'&&!a.includes('\0')&&a.length<=8000,'invalid_input','Invalid command argument'));
    requireValue(path.isAbsolute(v.command)||!/[\\/]/.test(v.command),'invalid_input','Use a PATH command or an absolute installed executable');
    const command=executable(v.command)??(v.command==='node'?process.execPath:null);requireValue(command,'missing_executable',`Verification executable unavailable: ${v.command}`);
    requireValue(!within(snapshot.cwd,command),'invalid_input','Verification executable must be installed outside the source project; pass project scripts as arguments');
    return {command,args:v.args,cwd:relativePath(v.cwd??'.','verification cwd',{dot:true}),timeout_seconds:integer(v.timeout_seconds??120,1,1800,'verification timeout')};
  };
  const verification=raw.verification.map(normalize),setup=(raw.setup??[]).map(normalize);
  return {write_paths,setup,verification,max_attempts:integer(raw.max_attempts??2,1,5,'max_attempts')};
}
export function commandDirectory(workspace,relative) {
  const cwd=real(path.resolve(workspace.cwd,relative));requireValue(within(workspace.root,cwd),'path_not_allowed','Verification cwd escapes worktree');return cwd;
}
export async function observeExecution(file) {
  let observed=baseObservation();
  for(const e of await events(file)) {
    if(e.type==='aw_session')observed.session_id=e.session_id;
    if(e.type==='aw_execution_result')observed={...observed,...e.observation,final:true,execution:e.execution};
  }
  return observed;
}
