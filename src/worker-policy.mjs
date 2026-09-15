import fs from 'node:fs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {atomicJson,fields,integer,real,requireValue} from './core.mjs';
import {budgetPolicy,DEFAULT_BUDGET} from './budget.mjs';

export function requestPolicy(snapshot,raw) {
  const budget=budgetPolicy(raw.budget??{},snapshot.budget??DEFAULT_BUDGET,{lowerOnly:true});
  const read_mode=raw.read_mode??snapshot.read_mode??(snapshot.role.access==='read-only'?'evidence':'native');
  requireValue(['evidence','native'].includes(read_mode),'invalid_input','read_mode must be evidence or native');
  requireValue(snapshot.role.access==='read-only'||read_mode==='native','invalid_input','Writable workers require native file tools');
  return {budget,read_mode};
}
export function controlDescription(adapter,readMode) {
  return {
    model_steps:['claude','opencode'].includes(adapter)?'native turn limit plus observed-event guard':'observed response/tool events; hidden model rounds are unreported',
    output_tokens:'stop on reported usage; an in-flight request may exceed the threshold; missing usage stays unknown',
    reads:readMode==='evidence'?(['acp','dsh'].includes(adapter)?'AW-bounded UTF-8 evidence; ACP file capabilities and permissions denied; native tools must honor the protocol':'AW-bounded UTF-8 evidence; native filesystem tools disabled'):
      ['acp','dsh'].includes(adapter)?'ACP file/permission allowlist; agent-native tools must honor permissions':
      adapter==='opencode'?'native path permissions plus post-event observation':
      adapter==='claude'?'post-event path/output observation; not a pre-read sandbox':
      'native sandbox and observed command-output bounds; shell read_paths are advisory',
    rollback:'budget stops preserve files and partial reports; no automatic rollback'
  };
}
export function evidenceBundle(request,cwd) {
  const ranges=new Map();
  requireValue(Array.isArray(request.read_ranges??[]),'invalid_input','read_ranges must be an array');
  for(const r of request.read_ranges??[]) {
    fields(r,['path','start_line','end_line'],'read range');const file=real(path.resolve(cwd,r.path));
    requireValue(request.read_paths.includes(file)&&!ranges.has(file),'invalid_input','Each range must name a distinct read_paths file');
    integer(r.start_line,1,10000000,'start_line');integer(r.end_line,r.start_line,10000000,'end_line');ranges.set(file,r);
  }
  let total=0;const files=[];
  for(const file of request.read_paths) {
    const stat=fs.statSync(file),range=ranges.get(file);
    requireValue(stat.isFile(),'evidence_requires_files','Evidence mode requires individual text files; select files/ranges or explicitly request native reading');
    const fd=fs.openSync(file,'r');let content;
    try {
      requireValue(fs.fstatSync(fd).isFile(),'invalid_input','Evidence must be a regular file');
      if(!range) {
        requireValue(stat.size<=request.budget.max_read_bytes,'read_budget_exceeded',`Evidence file exceeds max_read_bytes; select a line range: ${file}`);
        const buffer=Buffer.alloc(request.budget.max_read_bytes+1),size=fs.readSync(fd,buffer,0,buffer.length,0);
        requireValue(size<=request.budget.max_read_bytes,'read_budget_exceeded','Evidence grew beyond the read budget');content=buffer.subarray(0,size);
      }else {
        requireValue(stat.size<=64*1024*1024,'input_too_large','Select a smaller evidence file before applying line ranges to files over 64 MiB');
        const buffer=Buffer.alloc(8192),parts=[];let position=0,line=1,size=0,done=false;
        while(!done) {
          const n=fs.readSync(fd,buffer,0,buffer.length,position);if(!n)break;position+=n;
          for(let i=0;i<n;i++) {
            if(line>=range.start_line&&line<=range.end_line){parts.push(buffer[i]);size++;requireValue(size<=request.budget.max_read_bytes,'read_budget_exceeded','Selected evidence range exceeds max_read_bytes');}
            if(buffer[i]===10)line++;
            if(line>range.end_line){done=true;break;}
          }
        }
        requireValue(line>=range.start_line,'invalid_input','Evidence range starts after end of file');content=Buffer.from(parts);
      }
    }finally {fs.closeSync(fd);}
    total+=content.length;requireValue(total<=request.budget.max_total_read_bytes,'read_budget_exceeded','Evidence bundle exceeds max_total_read_bytes; narrow the supplied evidence');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{requireValue(false,'evidence_not_text','Evidence mode supports UTF-8 text; use an explicit native task for binary evidence');}
    requireValue(!text.includes('\0'),'evidence_not_text','Evidence mode does not accept binary files');
    files.push({path:file,start_line:range?.start_line??1,end_line:range?.end_line??null,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex'),text});
  }
  return {files,bytes:total};
}
export function readScope(snapshot,request) {
  const names=[...request.read_paths,...(snapshot.project_instructions??[]).map(x=>x.path)];
  for(const p of request.execution?.write_paths??[])names.push(path.resolve(snapshot.cwd,p));
  return {cwd:snapshot.cwd,mode:request.read_mode,paths:[...new Set(names)].map(p=>({path:p,directory:fs.existsSync(p)?fs.statSync(p).isDirectory():true}))};
}
export function guardedCommand(command,snapshot,files,{request,remaining,telemetryFile}={}) {
  const file=path.join(files.directory,'worker-guard.json');
  atomicJson(file,{command:{...command,cwd:snapshot.cwd},adapter:snapshot.provider.adapter,contract:snapshot.role.result_contract,budget:remaining??request.budget,
    scope:readScope(snapshot,request),telemetry_file:telemetryFile??path.join(files.directory,'telemetry.json'),evidence_bytes:snapshot.evidence_bytes??0});
  return {command:process.execPath,args:[path.join(import.meta.dirname,'worker-guard.mjs'),file],env:command.env,stdin_file:command.stdin_file};
}
