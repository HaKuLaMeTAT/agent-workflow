import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {executable} from './adapters/common.mjs';
import {atomicJson,readJson,real,within,requireValue,hash} from './core.mjs';
import {createDirectory,assertDirectory,captureDirectory,discardDirectory} from './directories.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function git(cwd,args,{env={},input}={}) {
  const binary=executable('git');requireValue(binary,'git_unavailable','Execution workspaces require Git on PATH');
  // Do not inherit a caller's index, worktree, or injected Git configuration.
  const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  const r=spawnSync(binary,['-c','core.hooksPath='+path.join(import.meta.dirname,'disabled-hooks'),'-c','core.fsmonitor=false',...args],
    {cwd,env:{...clean,...env,GIT_TERMINAL_PROMPT:'0'},input,encoding:null,maxBuffer:16*1024*1024,timeout:30000,windowsHide:true});
  requireValue(!r.error&&r.status===0,'git_failed',`git ${args[0]} failed: ${String(r.stderr??r.error?.message??'').slice(0,1600)}`);
  return r.stdout;
}
export function repository(cwd) {return real(git(cwd,['rev-parse','--show-toplevel']).toString().trim());}
export function cleanSource(root,base) {
  requireValue(git(root,['rev-parse','HEAD']).toString().trim()===base,'source_changed','Source HEAD changed; reconcile explicitly before applying');
  requireValue(git(root,['status','--porcelain=v1','--untracked-files=all']).length===0,'dirty_source','Commit or otherwise resolve source changes before creating/applying a workspace; AW does not stash them');
}
export function createWorkspace(snapshot,directory,owner,request) {
  if(request?.execution.workspace.mode==='directory')return createDirectory(snapshot,directory,owner,request);
  const source=repository(snapshot.cwd),base=git(source,['rev-parse','HEAD']).toString().trim();cleanSource(source,base);
  requireValue(!within(source,directory),'invalid_workspace_location','AW state directory must be outside the target repository');
  const manifest=path.join(directory,'workspace.json');
  if(fs.existsSync(manifest)) {
    const prior=readJson(manifest);
    requireValue(prior.owner===owner&&prior.source_cwd===snapshot.cwd&&prior.base_sha===base&&prior.root===path.join(real(directory),'worktree'),'workspace_changed','Pre-launch workspace does not match this request');
    assertWorkspace(prior);return prior;
  }
  const entries=git(source,['ls-files','--stage']).toString();
  requireValue(!/^(160000|120000) /m.test(entries),'workspace_unsupported','Execution workspaces currently require a repository without submodules or tracked symlinks');
  const root=path.join(directory,'worktree');
  git(source,['worktree','add','--detach',root,base]);
  const workspace={schema_version:1,owner,source_root:source,source_cwd:snapshot.cwd,root:real(root),cwd:real(path.join(root,path.relative(source,snapshot.cwd))),git_dir:real(git(root,['rev-parse','--absolute-git-dir']).toString().trim()),base_sha:base,state:'retained'};
  atomicJson(path.join(directory,'workspace.json'),workspace);return workspace;
}
export function assertWorkspace(workspace) {
  if(workspace.mode==='directory')return assertDirectory(workspace);
  requireValue(workspace.state==='retained','workspace_closed','Workspace has been applied or discarded; start a new task');
  requireValue(real(workspace.root)===workspace.root&&repository(workspace.root)===workspace.root,'workspace_changed','Owned worktree is missing or was replaced');
  requireValue(real(git(workspace.root,['rev-parse','--absolute-git-dir']).toString().trim())===workspace.git_dir,'workspace_changed','Worktree Git identity changed');
  requireValue(git(workspace.root,['rev-parse','HEAD']).toString().trim()===workspace.base_sha,'workspace_changed','Worker changed the workspace HEAD');
  const common=real(git(workspace.root,['rev-parse','--path-format=absolute','--git-common-dir']).toString().trim());
  const sourceCommon=real(git(workspace.source_root,['rev-parse','--path-format=absolute','--git-common-dir']).toString().trim());
  requireValue(common===sourceCommon,'workspace_changed','Worktree belongs to a different repository');
}
export function workspaceRequest(request,workspace) {
  return {...request,read_paths:request.read_paths.map(p=>within(workspace.root,p)?p:path.join(workspace.root,path.relative(workspace.source_root,p)))};
}
export function ancestorInstructions(cwd) {
  const dirs=[];for(let current=cwd;;current=path.dirname(current)){dirs.unshift(current);if(path.dirname(current)===current)break;}
  const output=[];
  for(const dir of dirs)for(const name of ['AGENTS.md','CLAUDE.md']) {
    const file=path.join(dir,name);if(!fs.existsSync(file))continue;
    requireValue(fs.statSync(file).size<=64000,'input_too_large',`Instruction file too large: ${file}`);
    output.push({path:file,text:fs.readFileSync(file,'utf8')});
  }
  return output;
}
function safeEntry(root,name) {
  const target=path.resolve(root,name);requireValue(within(root,target),'path_not_allowed','Changed path escapes worktree');
  for(let current=target;within(root,current)&&current!==root;current=path.dirname(current)) {
    const s=fs.lstatSync(current,{throwIfNoEntry:false});
    requireValue(!s?.isSymbolicLink(),'path_not_allowed',`Symlink/reparse path cannot be delivered: ${name}`);
  }
}
// The private index captures new/deleted/binary files without staging the user's index.
export function captureChanges(workspace,execution,directory) {
  if(workspace.mode==='directory')return captureDirectory(workspace,execution);
  assertWorkspace(workspace);
  const index=path.join(directory,'capture.index'),env={GIT_INDEX_FILE:index};
  try {
    git(workspace.root,['read-tree',workspace.base_sha],{env});
    git(workspace.root,['add','-A','--','.'],{env});
    const files=git(workspace.root,['diff','--cached','--name-only','-z',workspace.base_sha],{env}).toString().split('\0').filter(Boolean);
    const allowed=execution.write_paths.map(p=>path.resolve(workspace.cwd,p));
    for(const name of files) {
      safeEntry(workspace.root,name);
      requireValue(allowed.some(root=>within(root,path.resolve(workspace.root,name))),'write_scope_exceeded',`Change outside write_paths: ${name}`);
    }
    const patch=git(workspace.root,['diff','--cached','--binary','--full-index','--no-ext-diff','--no-textconv',workspace.base_sha],{env});
    // Include working bytes as well as the patch, so filters/line endings cannot hide a changed tested snapshot.
    const content=files.map(name=>{const file=path.join(workspace.root,name);return [name,fs.existsSync(file)?digest(fs.readFileSync(file)):null];});
    return {files,patch,patch_sha256:digest(patch),snapshot_hash:hash({base:workspace.base_sha,content,patch:digest(patch)})};
  }finally {fs.rmSync(index,{force:true});fs.rmSync(index+'.lock',{force:true});}
}
export function applyChanges(workspace,execution,report,directory,{write=false}={}) {
  requireValue(workspace.mode!=='directory','apply_unsupported','Directory mode writes its deliverables directly; it has no patch apply step');
  assertWorkspace(workspace);cleanSource(workspace.source_root,workspace.base_sha);
  requireValue(report.outcome==='verified','unverified_changes','Only verified execution changes can be applied');
  const current=captureChanges(workspace,execution,directory);
  requireValue(current.snapshot_hash===report.snapshot_hash,'workspace_changed','Changes differ from the verified snapshot');
  const patch=fs.readFileSync(report.patch_path);
  requireValue(digest(patch)===report.patch_sha256&&current.patch_sha256===report.patch_sha256,'artifact_changed','Patch differs from the verified artifact');
  if(patch.length)git(workspace.source_root,['apply','--check','--binary','-'],{input:patch});
  if(write&&patch.length)git(workspace.source_root,['apply','--binary','-'],{input:patch});
  return {written:write,source_root:workspace.source_root,base_sha:workspace.base_sha,files:current.files,snapshot_hash:current.snapshot_hash};
}
export function discardWorkspace(workspace) {
  if(workspace.mode==='directory')return discardDirectory(workspace);
  requireValue(['retained','applied'].includes(workspace.state),'workspace_closed','Workspace already discarded');
  assertWorkspace({...workspace,state:'retained'});
  git(workspace.source_root,['worktree','remove','--force',workspace.root]);
}
