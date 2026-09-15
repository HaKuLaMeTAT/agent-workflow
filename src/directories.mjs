import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requireValue,real,within,hash,atomicJson,readJson} from './core.mjs';
import {scopeContains} from './execution.mjs';

const LIMIT=10000;
function digest(file) {
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024),sum=createHash('sha256');
  try{let n;while((n=fs.readSync(fd,buffer))>0)sum.update(buffer.subarray(0,n));return sum.digest('hex');}finally{fs.closeSync(fd);}
}
const identity=root=>{const s=fs.statSync(root);return {dev:s.dev,ino:s.ino,birthtime_ms:s.birthtimeMs};};
function entries(root,scratch=[]) {
  const output={};let count=0;
  function walk(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.name.toLowerCase()==='.git')continue;
      const file=path.join(dir,entry.name),name=path.relative(root,file).split(path.sep).join('/');
      if(scopeContains(scratch,name))continue;
      requireValue(++count<=LIMIT,'directory_too_large','Directory mode supports at most 10000 entries; use a task-specific directory and explicit inputs');
      requireValue(!entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile()),'directory_unsupported','Directory inputs/deliverables must be ordinary files or directories: '+name);
      if(entry.isDirectory())walk(file);
      else {const s=fs.statSync(file);output[name]={sha256:digest(file),bytes:s.size,mode:s.mode&0o777};}
    }
  }
  walk(root);return output;
}
function copyInputs(snapshot,root,readPaths) {
  const selected=[...new Set(readPaths)].filter(p=>!readPaths.some(q=>q!==p&&within(q,p)));
  let count=0,total=0;
  function copy(source,target) {
    const stat=fs.lstatSync(source);
    requireValue(!stat.isSymbolicLink()&&(stat.isFile()||stat.isDirectory()),'directory_unsupported','Input copies cannot include symbolic links or special files');
    requireValue(++count<=LIMIT,'directory_too_large','Too many input entries');
    if(stat.isDirectory()) {
      fs.mkdirSync(target,{recursive:true});
      for(const name of fs.readdirSync(source))if(name.toLowerCase()!=='.git')copy(path.join(source,name),path.join(target,name));
    }else {
      total+=stat.size;requireValue(total<=128*1024*1024,'directory_too_large','Temporary input copies exceed 128 MiB; select fewer input files or use target=cwd');
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,stat.mode&0o777);
    }
  }
  for(const source of selected) {
    requireValue(within(snapshot.cwd,source)&&!within(source,root),'path_not_allowed','Input copy must remain within the supplied cwd and cannot include AW output');
    const relative=path.relative(snapshot.cwd,source);
    requireValue(!relative.split(path.sep).some(p=>p.toLowerCase()==='.git'),'path_not_allowed','Git metadata is not a directory input');
    copy(source,path.join(root,relative));
  }
}

export function createDirectory(snapshot,directory,owner,request) {
  const options=request.execution.workspace,owned=options.target==='temporary',manifest=path.join(directory,'workspace.json');
  const root=owned?path.join(real(directory),'output'):real(snapshot.cwd);
  requireValue(owned||!within(root,directory),'invalid_workspace_location','AW state must be outside a user-supplied execution directory');
  if(fs.existsSync(manifest)) {
    const prior=readJson(manifest,8*1024*1024);requireValue(prior.mode==='directory'&&prior.owner===owner&&prior.root===root&&hash(prior.options)===hash(options),'workspace_changed','Existing directory workspace differs from request');
    assertDirectory(prior);return prior;
  }
  if(owned) {
    // A failed preflight can leave copied inputs; never adopt unexplained files.
    requireValue(!fs.existsSync(root),'workspace_changed','Unregistered output directory exists; inspect it before retrying');
    fs.mkdirSync(root,{mode:0o700});
    try{copyInputs(snapshot,root,request.read_paths);}catch(e){fs.rmSync(root,{recursive:true,force:true});throw e;}
  }
  const baseline=entries(root,request.execution.scratch_paths);
  if(!owned&&options.overwrite==='deny')requireValue(!Object.keys(baseline).some(name=>scopeContains(request.execution.write_paths,name)),'overwrite_not_allowed','write_paths includes existing files; narrow the scope or explicitly choose workspace.overwrite=allow');
  const workspace={schema_version:1,mode:'directory',owner,owned,source_root:snapshot.cwd,source_cwd:snapshot.cwd,root,cwd:root,identity:identity(root),state:'retained',options,baseline,scratch_paths:request.execution.scratch_paths};
  requireValue(Buffer.byteLength(JSON.stringify(workspace))<=8*1024*1024,'directory_too_large','Directory manifest exceeds 8 MiB');
  atomicJson(manifest,workspace);return workspace;
}
export function assertDirectory(workspace) {
  requireValue(workspace.state==='retained','workspace_closed','Directory task has been closed');
  requireValue(real(workspace.root)===workspace.root&&hash(identity(workspace.root))===hash(workspace.identity),'workspace_changed','Execution directory was removed or replaced');
}
export function captureDirectory(workspace,execution) {
  assertDirectory(workspace);
  const current=entries(workspace.root,workspace.scratch_paths),names=[...new Set([...Object.keys(workspace.baseline),...Object.keys(current)])].sort();
  const files=names.filter(name=>hash(workspace.baseline[name]??null)!==hash(current[name]??null));
  for(const name of files)requireValue(scopeContains(execution.write_paths,name),'write_scope_exceeded','Directory changed outside write_paths: '+name);
  const artifacts=files.map(name=>({path:path.join(workspace.root,name),relative_path:name,status:!current[name]?'deleted':!workspace.baseline[name]?'created':'modified',...(current[name]??{})}));
  return {files,artifacts,snapshot_hash:hash(current)};
}
export function discardDirectory(workspace) {
  assertDirectory(workspace);
  if(workspace.owned)fs.rmSync(workspace.root,{recursive:true,force:true});
  return {removed:workspace.owned,retained_directory:workspace.owned?null:workspace.root,rollback:false};
}
