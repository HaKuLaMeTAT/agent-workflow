import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyCall,filePolicy} from '../src/adapters/acp-permissions.mjs';
import {terminals} from '../src/adapters/acp-terminals.mjs';

test('ACP scope: new files, linked paths, moves and DSH partial tool metadata',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw acp 中文-')),cwd=path.join(root,'work');fs.mkdirSync(cwd);fs.mkdirSync(path.join(cwd,'src'));
  fs.writeFileSync(path.join(cwd,'src/existing'),'inside');fs.writeFileSync(path.join(root,'outside'),'outside');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const policy=filePolicy(cwd,{access:'workspace-write',write_paths:['src']}),call=(kind,...names)=>({kind,locations:names.map(p=>({path:path.resolve(cwd,p)}))});
  assert.equal(policy.allows(call('edit','src/new/nested.txt')),true);
  for(const c of [call('edit','outside.txt'),call('edit','../outside'),call('edit','src/.git/config'),call('edit','src/odd.'),call('move','src/existing','../outside'),call('execute','src/existing'),{kind:'edit',locations:[]}])assert.equal(policy.allows(c),false,JSON.stringify(c));
  fs.symlinkSync(root,path.join(cwd,'src/link'),process.platform==='win32'?'junction':'dir');
  assert.equal(policy.allows(call('edit','src/link/new')),false);
  fs.linkSync(path.join(root,'outside'),path.join(cwd,'src/hard'));assert.equal(policy.allows(call('edit','src/hard')),false);
  assert.equal(filePolicy(cwd).allows(call('edit','src/existing')),false);
  for(const title of ['write','edit','str_replace_editor']){
    const c=classifyCall({toolCallId:'1',kind:'other',title,rawInput:{file_path:'src/new',path:'src/new',command:'create'}},'dsh',cwd);
    assert.equal(policy.allows(c),true);
  }
  assert.equal(policy.allows(classifyCall({title:'grep',rawInput:{}},'dsh',cwd)),true);
  assert.equal(policy.allows(classifyCall({title:'bash',rawInput:{command:'echo test'}},'dsh',cwd)),false);
  const full=filePolicy(cwd,{access:'workspace-write',permissions:'full-access',write_paths:['src']});
  assert.equal(full.allows(classifyCall({title:'bash'},'dsh',cwd)),true);
  assert.equal(full.allows(classifyCall({title:'subagent'},'dsh',cwd)),false);
  assert.equal(full.file(path.join(root,'outside'),{write:true}),path.join(root,'outside'));
});

test('ACP terminal: argv execution, bounded Unicode output, exit and release',async t=>{
  const terminal=terminals({executable:process.execPath},os.tmpdir());t.after(()=>terminal.close());
  const sessionId='session';
  const {terminalId}=await terminal.handle('terminal/create',{sessionId,command:process.execPath,args:['-e','process.stdout.write("中文🙂".repeat(20))'],outputByteLimit:13});
  assert.equal((await terminal.handle('terminal/wait_for_exit',{sessionId,terminalId})).exitCode,0);
  const output=await terminal.handle('terminal/output',{sessionId,terminalId});
  assert.equal(output.truncated,true);assert.ok(Buffer.byteLength(output.output)<=13);assert.ok(!output.output.includes('\ufffd'));
  await assert.rejects(terminal.handle('terminal/output',{sessionId:'other',terminalId}),{code:'permission_blocked'});
  await terminal.handle('terminal/release',{sessionId,terminalId});
  await assert.rejects(terminal.handle('terminal/output',{sessionId,terminalId}),{code:'permission_blocked'});
});

test('ACP terminal: kill reaps the running command and its child',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw-terminal-'));
  const terminal=terminals({executable:process.execPath},root);t.after(async()=>{await terminal.close();fs.rmSync(root,{recursive:true,force:true});});
  const {processIdentity,sameProcess,sleep}=await import('../src/core.mjs');
  const code='const fs=require("fs"),{spawn}=require("child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("child.pid",String(child.pid));setInterval(()=>{},1000);';
  const sessionId='kill',created=await terminal.handle('terminal/create',{sessionId,command:process.execPath,args:['-e',code]});
  const file=path.join(root,'child.pid');for(let n=0;n<80&&!fs.existsSync(file);n++)await sleep(50);
  assert.ok(fs.existsSync(file));const identity=processIdentity(Number(fs.readFileSync(file,'utf8')));assert.ok(identity);
  await terminal.handle('terminal/kill',{sessionId,...created});
  for(let n=0;n<40&&sameProcess(identity);n++)await sleep(50);
  assert.equal(sameProcess(identity),false);
  assert.ok((await terminal.handle('terminal/output',{sessionId,...created})).exitStatus);
  await terminal.handle('terminal/release',{sessionId,...created});
});
