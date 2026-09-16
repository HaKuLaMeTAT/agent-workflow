import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {git} from '../src/workspaces.mjs';
import {permissionBase,pathPermissions} from '../src/adapters/opencode-permissions.mjs';
import {opencode} from '../src/adapters/opencode.mjs';
import {readAccess,telemetry} from '../src/telemetry.mjs';

function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw OpenCode 中文 space-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('OpenCode permission bases: non-Git, nested Git cwd, linked worktree and unresolved Git',t=>{
  const root=temporary(t);assert.equal(permissionBase(root,process.env),'/');
  git(root,['init']);git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','base']);
  const nested=path.join(root,'nested');fs.mkdirSync(nested);assert.equal(permissionBase(nested,process.env),fs.realpathSync(root));
  const linked=path.join(root,'linked');git(root,['worktree','add','--detach',linked]);
  fs.mkdirSync(path.join(linked,'sub'));assert.equal(permissionBase(path.join(linked,'sub'),process.env),fs.realpathSync(linked));
  assert.throws(()=>permissionBase(root,{PATH:''}),{code:'permission_base_unknown'});
});
test('OpenCode Windows paths use the child drive and only the native base; no cwd/absolute aliases',()=>{
  const cwd='C:\\Users\\Alice\\AW 中文\\output',target='out/aw-migration.txt';
  const permissions=pathPermissions(cwd,'/',[target],path.win32);
  assert.equal(permissions['Users/Alice/AW 中文/output/out/aw-migration.txt'],'allow');
  assert.equal(permissions[target],undefined);assert.equal(permissions['C:/Users/Alice/AW 中文/output/'+target],undefined);
  assert.equal(permissions['Users/Alice/AW 中文/output/out/sibling.txt'],undefined);assert.equal(permissions['*'],'deny');
  const d=pathPermissions('D:\\project\\sub','D:\\project',['out/file'],path.win32);assert.equal(d['sub/out/file'],'allow');assert.equal(d['out/file'],undefined);
  assert.equal(pathPermissions('/tmp/project/sub','/tmp/project',['out/file'],path.posix)['sub/out/file'],'allow');
  assert.throws(()=>pathPermissions('/tmp','/',['literal?.txt'],path.posix),{code:'permission_path_unsupported'});
});
test('OpenCode restricted search is denied; declared read and edit use identical bases',t=>{
  const cwd=temporary(t),snapshot={cwd,provider:{executable:process.execPath},model:'fixture/model',effort:null,role:{access:'workspace-write',permissions:'restricted'},request:{read_paths:[path.join(cwd,'input')]},execution:{write_paths:['out/file']}};
  const c=opencode.prepare(snapshot,{directory:cwd,prompt:path.join(cwd,'prompt')});const p=JSON.parse(c.env.OPENCODE_CONFIG_CONTENT).permission;
  for(const tool of ['glob','grep','list','external_directory'])assert.equal(p[tool],'deny');
  const expected=pathPermissions(cwd,'/',['out/file']);assert.deepEqual(p.edit,expected);
  for(const k of Object.keys(expected).filter(k=>k!=='*'))assert.equal(p.read[k],'allow');
});
test('read scope distinguishes missing targets, existing files, unauthorized paths and symlink escapes',t=>{
  const root=temporary(t),out=path.join(root,'out');fs.mkdirSync(out);
  const scope={cwd:root,mode:'native',paths:[{path:path.join(out,'file'),directory:true}]};
  assert.deepEqual(readAccess('out/file',scope),{allowed:true,missing:true});
  assert.equal(readAccess('out/sibling',scope).allowed,false);
  fs.writeFileSync(path.join(out,'file'),'yes');assert.deepEqual(readAccess('out/file',scope),{allowed:true,missing:false});
  assert.equal(readAccess('out/file/child',scope).allowed,false);
  const allowed={cwd:root,paths:[{path:out,directory:true}]},outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(out,'link'),process.platform==='win32'?'junction':'dir');
  assert.equal(readAccess('out/link/missing',allowed).allowed,false);
  fs.rmSync(outside,{recursive:true});assert.equal(readAccess('out/link/missing',allowed).allowed,false);
  const meter=telemetry('opencode',{scope});
  meter.ingest({type:'tool_use',part:{id:'write',tool:'write',state:{status:'error',input:{filePath:'out/file'},error:'The user rejected this permission request'}}});
  fs.unlinkSync(path.join(out,'file'));
  meter.ingest({type:'tool_use',part:{id:'read',tool:'read',state:{status:'error',input:{filePath:'out/file'},error:'File not found'}}});
  assert.equal(meter.snapshot().tool_error.code,'permission_blocked');assert.equal(meter.snapshot().scope_error,null);assert.equal(meter.snapshot().missing_read.code,'read_target_missing');
  meter.ingest({type:'tool_use',part:{id:'outside',tool:'read',state:{status:'error',input:{filePath:'other'},error:'File not found'}}});
  assert.equal(meter.snapshot().scope_error.code,'read_scope_exceeded');assert.equal(meter.snapshot().tool_error.tool,'write');
});
