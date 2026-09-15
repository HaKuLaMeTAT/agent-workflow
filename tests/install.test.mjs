import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {installLocal} from '../scripts/install-local.mjs';
import {applyUpstreamPatch} from '../scripts/patch-upstream.mjs';
import {TOOL_ROOT,loadHost} from '../src/config.mjs';
import {readJson,atomicJson} from '../src/core.mjs';
import {userPaths} from '../src/paths.mjs';
import {runtimeFixture} from './fixtures/helpers.mjs';
import {executable,command,environment} from '../src/adapters/common.mjs';
import {providerFixture} from './fixtures/helpers.mjs';

const upstream=process.env.AW_TEST_UPSTREAM;
const options={skip:!upstream?'Set AW_TEST_UPSTREAM for installation integration':false};
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aw install 中文 & space-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function checkout(parent,name) {
  const root=path.join(parent,name);fs.mkdirSync(root);
  for(const file of ['package.json','bin','src','scripts','skills','config','roles','patches','node_modules'])fs.cpSync(path.join(TOOL_ROOT,file),path.join(root,file),{recursive:true,filter:source=>!source.endsWith('.local.json')&&path.basename(source)!=='.bin'});
  const runtime=path.join(root,'.runtime/node_modules/ai-cli-mcp');runtimeFixture(upstream,runtime);applyUpstreamPatch(runtime);
  return root;
}
test('platform defaults use native user locations and custom CODEX_HOME',()=>{
  const win=userPaths({platform:'win32',home:'C:\\Users\\名字',env:{LOCALAPPDATA:'D:\\Local Data',CODEX_HOME:'E:\\Codex Home'}});
  assert.equal(win.host,'D:\\Local Data\\agent-workflow\\host.json');
  assert.equal(win.state,'D:\\Local Data\\agent-workflow\\state');
  assert.equal(win.skill,'E:\\Codex Home\\skills\\agent-workflow');
  assert.equal(userPaths({platform:'linux',home:'/users/name',env:{}}).host,'/users/name/.config/agent-workflow/host.json');
});
test('CLI discovery and argument transport preserve spaces, quotes, JSON and shell metacharacters',async t=>{
  const dir=temporary(t),file=path.join(dir,'echo.mjs');
  fs.writeFileSync(file,'console.log(JSON.stringify(process.argv.slice(2)));');
  const cli=process.platform==='win32'?path.join(dir,'echo.cmd'):process.execPath;
  if(process.platform==='win32')fs.writeFileSync(cli,`@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`);
  const p={executable:cli,args:process.platform==='win32'?[]:[file],inherit_env:[]};
  const args=['hello world','中文',JSON.stringify({a:'a "quoted" value',b:'& | < > ^ %PATH% !x! $(echo nope) `no`'}),''];
  assert.deepEqual(JSON.parse((await command(p,args)).stdout),args);
  assert.equal(path.relative(executable(process.platform==='win32'?cli.slice(0,-4):process.execPath),fs.realpathSync(cli)),'');
  const fixture=providerFixture(dir);
  assert.match((await command({executable:fixture,args:[],inherit_env:[]},['--version'])).stdout,/fixture/);
  if(process.platform==='win32')for(const key of ['SystemRoot','USERPROFILE','LOCALAPPDATA'])assert.ok(environment(p)[key],key);
});
test('install from arbitrary checkout; launch without PATH; re-register moved checkout preserving edits',options,async t=>{
  const base=temporary(t),root=checkout(base,'checkout one'),unrelated=path.join(base,'unrelated project');fs.mkdirSync(unrelated);
  const source=path.join(root,'config/office.example.json'),hostFile=path.join(base,'private config','host.json'),binDir=path.join(base,'user bin'),skillDir=path.join(base,'codex skills','agent-workflow');
  const installed=await installLocal({source,root,hostFile,binDir,skillDir});
  assert.equal(installed.version,readJson(path.join(root,'package.json')).version);assert.equal(fs.lstatSync(skillDir).isSymbolicLink(),false);
  const manifest=readJson(path.join(skillDir,'installation.json'));
  assert.ok(fs.existsSync(path.join(skillDir,'references/execution.md')));
  assert.equal(manifest.tool_root,root);assert.equal(manifest.node,process.execPath);
  const env={...process.env,PATH:'',AW_ROOT:'',AW_HOST_CONFIG:''};
  const launch=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(skillDir,'aw.mjs'),...args],{cwd:unrelated,env,encoding:'utf8'}));
  assert.equal(launch('roles').length,8);
  const settings=readJson(hostFile);settings.host_id='custom-edited';atomicJson(hostFile,settings);
  await assert.rejects(installLocal({source,root,hostFile,binDir,skillDir}),{code:'already_exists'});
  const moved=path.join(base,'moved checkout 中文');fs.renameSync(root,moved);
  await installLocal({update:true,root:moved,hostFile,binDir,skillDir});
  assert.equal(readJson(hostFile).host_id,'custom-edited');assert.ok(loadHost(hostFile).upstream_dir.startsWith(moved));assert.equal(launch('roles').length,8);
  // Explicit configuration wins over the registered host.
  assert.equal(launch('roles','--host-config',path.join(moved,'config/home.example.json'))[0].provider,'claude-local');
  const before=fs.readFileSync(hostFile,'utf8');
  const broken=path.join(base,'broken.json');atomicJson(broken,{...readJson(hostFile),upstream_dir:base});
  await assert.rejects(installLocal({source:broken,update:true,root:moved,hostFile,binDir,skillDir}));
  assert.equal(fs.readFileSync(hostFile,'utf8'),before);
});
