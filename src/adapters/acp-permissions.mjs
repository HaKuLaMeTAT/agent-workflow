import fs from 'node:fs';
import path from 'node:path';
import {requireValue,real,within} from '../core.mjs';
import {relativePath} from '../execution.mjs';

// DSH 0.1.x sends kind=other plus rawInput, then asks permission using only
// toolCallId. Classify its documented native tools after merging those updates.
export function classifyCall(call,adapter,cwd) {
  if(adapter!=='dsh'||(call.kind&&call.kind!=='other'))return call;
  const input=call.rawInput??{},name=call.title;let kind,paths;
  if(['read','read_image','write','edit'].includes(name)) {
    kind=['read','read_image'].includes(name)?'read':'edit';
    paths=name==='read'&&Array.isArray(input.files)?input.files.map(x=>x.path):[input.file_path];
  }else if(['glob','grep'].includes(name)){kind='search';paths=[input.path??cwd];}
  else if(name==='str_replace_editor'&&['view','create','str_replace','insert'].includes(input.command)) {
    kind=input.command==='view'?'read':'edit';paths=[input.path];
  }else if(['bash','pwsh'].includes(name))kind='execute';
  // Unknown DSH plugins are never silently treated as file tools.
  return kind?{...call,kind,locations:paths?.map(path=>({path}))??[]}:{...call,kind:'unknown'};
}

export function filePolicy(cwd,{access='read-only',permissions='restricted',write_paths=[],read_paths,read_mode='native'}={}) {
  const root=real(cwd),writing=access==='workspace-write',full=writing&&permissions==='full-access';
  const scope=write_paths.map(p=>path.resolve(root,relativePath(p,'write_paths')));
  const reads=read_paths?.map(p=>({path:real(path.resolve(root,p)),directory:fs.statSync(path.resolve(root,p)).isDirectory()}));
  function file(value,{write=false}={}) {
    requireValue(typeof value==='string'&&value.length>0&&!value.includes('\0'),'permission_blocked','Missing file path');
    const target=path.resolve(root,value);
    if(write)requireValue(writing,'permission_blocked','Writing is disabled');
    if(!write)requireValue(read_mode!=='evidence','permission_blocked','Evidence mode disables filesystem tools');
    if(full)return target;
    requireValue(within(root,target),'permission_blocked','File is outside workspace');
    if(!write){const resolved=real(target);requireValue(within(root,resolved),'permission_blocked','File resolves outside workspace');
      requireValue(!reads||reads.some(p=>resolved===p.path||(p.directory&&within(p.path,resolved)))||(writing&&scope.some(p=>within(p,resolved))),'permission_blocked','File is outside read_paths and write_paths');return resolved;}
    requireValue(scope.some(p=>within(p,target)),'permission_blocked','File is outside write_paths');
    const relative=path.relative(root,target).split(path.sep);
    requireValue(relative.every(p=>p&&!/^\.git$/i.test(p)&&!/[. ]$|[:\x00-\x1f]/.test(p)),'permission_blocked','Protected or ambiguous path');
    let current=root;
    for(const part of relative) {
      current=path.join(current,part);let stat;
      try{stat=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      requireValue(!stat.isSymbolicLink()&&within(root,real(current))&&(!stat.isFile()||stat.nlink===1),'permission_blocked','Linked paths cannot be written');
    }
    return target;
  }
  function allows(call) {
    if(read_mode==='evidence')return false;
    if(full)return call.kind!=='unknown';
    const write=['edit','delete','move'].includes(call.kind),read=['read','search'].includes(call.kind);
    if((!write&&!read)||(write&&!writing)||!call.locations?.length)return false;
    return call.locations.every(loc=>{try{file(loc.path,{write});return true;}catch{return false;}});
  }
  return {file,allows,writing,full,reading:read_mode!=='evidence'};
}
