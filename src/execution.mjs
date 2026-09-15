import fs from 'node:fs';
import path from 'node:path';
import {fields,strings,text,integer,requireValue,within,real} from './core.mjs';
import {executable,events,baseObservation} from './adapters/common.mjs';

export function scopeContains(paths,name) {
  const normalize=s=>process.platform==='win32'?s.toLowerCase():s,child=normalize(name);
  return paths.some(p=>child===normalize(p)||child.startsWith(normalize(p)+'/'));
}

export function relativePath(value,label,{dot=false}={}) {
  text(value,label,2000);
  if(dot&&value==='.')return value;
  requireValue(!path.isAbsolute(value)&&!/[\\:*?\[\](),\x00-\x1f\x7f]/.test(value)&&value.split('/').every(p=>p&&p!=='..'&&p!=='.'&&!/^\.git$/i.test(p)&&!/[. ]$/.test(p)),'invalid_input',`${label} must be a relative literal path using /, without wildcards, rule syntax, .. or .git`);
  return value;
}
export function executionRequest(snapshot,raw) {
  fields(raw,['write_paths','setup','verification','max_attempts','workspace','checks','scratch_paths'],'execution');
  const workspace=workspaceOptions(raw.workspace);
  strings(raw.write_paths,'write_paths');requireValue(raw.write_paths.length>0,'invalid_input','Execution requires write_paths');
  const write_paths=raw.write_paths.map(p=>relativePath(p,'write_paths'));
  const scratch_paths=strings(raw.scratch_paths??[],'scratch_paths').map(p=>relativePath(p,'scratch_paths'));
  requireValue(workspace.mode==='directory'||scratch_paths.length===0,'invalid_input','scratch_paths applies only to directory mode');
  for(const scratch of scratch_paths)requireValue(!scopeContains(write_paths,scratch)&&!write_paths.some(p=>scopeContains([scratch],p)),'invalid_input','Scratch and deliverable paths must not overlap');
  requireValue(Array.isArray(raw.verification??[])&&(raw.verification??[]).length<=12,'invalid_input','Expected at most 12 verification commands');
  requireValue(Array.isArray(raw.checks??[])&&(raw.checks??[]).length<=12,'invalid_input','Expected at most 12 file checks');
  requireValue((raw.verification??[]).length>0||(workspace.mode==='directory'&&(raw.checks??[]).length>0),'invalid_input','Git execution requires verification commands; directory execution requires a file check or verification command');
  const checks=(raw.checks??[]).map(c=>{
    fields(c,['type','path','min_bytes','contains'],'file check');
    requireValue(['file','text','json'].includes(c.type),'invalid_input','File check type must be file, text or json');
    const name=relativePath(c.path,'check path');
    requireValue(!scopeContains(scratch_paths,name),'invalid_input','Deliverable checks cannot target scratch paths');
    const contains=strings(c.contains??[],'contains');requireValue(c.type==='text'||contains.length===0,'invalid_input','contains applies only to text checks');
    return {type:c.type,path:name,min_bytes:integer(c.min_bytes??1,0,1024*1024*1024,'min_bytes'),contains};
  });
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
  const verification=(raw.verification??[]).map(normalize),setup=(raw.setup??[]).map(normalize);
  return {workspace,write_paths,scratch_paths,setup,verification,checks,max_attempts:integer(raw.max_attempts??2,1,5,'max_attempts')};
}
export function workspaceOptions(raw={mode:'git-worktree'}) {
  fields(raw,['mode','target','overwrite'],'workspace');
  requireValue(['git-worktree','directory'].includes(raw.mode),'invalid_input','workspace.mode must be git-worktree or directory');
  if(raw.mode==='git-worktree') {
    requireValue(raw.target===undefined&&raw.overwrite===undefined,'invalid_input','Git worktrees do not accept directory options');return {mode:raw.mode};
  }
  requireValue(['temporary','cwd'].includes(raw.target??'temporary'),'invalid_input','Directory target must be temporary or cwd');
  requireValue(['deny','allow'].includes(raw.overwrite??'deny'),'invalid_input','overwrite must be deny or allow');
  return {mode:raw.mode,target:raw.target??'temporary',overwrite:raw.overwrite??'deny'};
}

export function runFileCheck(workspace,check,directory) {
  const stdout_path=path.join(directory,'stdout.log'),stderr_path=path.join(directory,'stderr.log');let exit_code=0,message;
  try {
    const file=real(path.resolve(workspace.cwd,check.path));requireValue(within(workspace.root,file),'path_not_allowed','Check path escapes execution directory');
    const stat=fs.statSync(file);requireValue(stat.isFile()&&stat.size>=check.min_bytes,'file_check_failed','Expected a regular file of at least '+check.min_bytes+' bytes');
    if(check.type!=='file') {
      requireValue(stat.size<=16*1024*1024,'file_check_failed','Text/JSON checks support files up to 16 MiB');
      const content=fs.readFileSync(file,'utf8');
      if(check.type==='json')JSON.parse(content);
      else for(const value of check.contains)requireValue(content.includes(value),'file_check_failed','Required text is absent');
    }
    message=`${check.type} check passed: ${check.path}`;
  }catch(e){exit_code=1;message=`${check.type} check failed: ${check.path}: ${e.message}`;}
  fs.writeFileSync(stdout_path,exit_code?'':message+'\n');fs.writeFileSync(stderr_path,exit_code?message+'\n':'');
  return {...check,kind:'file',exit_code,error:null,stdout_path,stderr_path};
}
export function commandDirectory(workspace,relative) {
  const cwd=real(path.resolve(workspace.cwd,relative));requireValue(within(workspace.root,cwd),'path_not_allowed','Verification cwd escapes execution workspace');return cwd;
}
export async function observeExecution(file) {
  let observed=baseObservation();
  for(const e of await events(file)) {
    if(e.type==='aw_session')observed.session_id=e.session_id;
    if(e.type==='aw_execution_result')observed={...observed,...e.observation,final:true,execution:e.execution};
  }
  return observed;
}
