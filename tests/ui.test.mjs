import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {startUi} from '../src/ui-server.mjs';
import {readJson,atomicJson} from '../src/core.mjs';
import {TOOL_ROOT} from '../src/config.mjs';

test('local UI HTTP contract: guarded access, preview/save, CLI conflict and model directory fallback',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aw-ui-')),file=path.join(dir,'host.json');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=readJson(path.join(TOOL_ROOT,'config/home.example.json'));config.catalog=path.join(TOOL_ROOT,'config/roles.json');config.state_dir=path.join(dir,'state');
  config.providers['claude-local'].executable=path.join(dir,'uninstalled-claude');atomicJson(file,config);
  const ui=await startUi({hostConfig:file,cwd:dir});t.after(()=>ui.close());
  assert.equal(ui.server.address().address,'127.0.0.1');
  const token=new URLSearchParams(new URL(ui.url).hash.slice(1)).get('token');
  const call=(route,{body,headers={}}={})=>fetch(ui.origin+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  const html=await fetch(ui.origin);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const source=await html.text();assert.ok(!source.includes(token));assert.ok(!source.includes(file));
  assert.equal((await fetch(ui.origin+'/api/config')).status,401);
  assert.equal((await call('/api/config',{headers:{Origin:'https://outside.example'}})).status,403);
  const foreignHostStatus=await new Promise((resolve,reject)=>{http.get(ui.origin+'/api/config',{headers:{Host:'outside.example',Authorization:`Bearer ${token}`}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(foreignHostStatus,403);
  assert.equal((await call('/api/config',{headers:{'Sec-Fetch-Site':'same-site'}})).status,403);
  const before=await (await call('/api/config')).json(),original=fs.readFileSync(file,'utf8');
  const body={revision:before.revision,changes:[{role:'reviewer',patch:{effort:'medium'}}]};
  assert.equal((await call('/api/preview',{body})).status,200);assert.equal(fs.readFileSync(file,'utf8'),original);
  const edited=await call('/api/config',{body});assert.equal(edited.status,200);const after=await edited.json();assert.notEqual(after.revision,before.revision);
  assert.equal((await call('/api/config',{body})).status,409);
  assert.equal((await call('/api/config',{body:{...body,revision:after.revision,changes:[{role:'reviewer',patch:{model:'unconfigured'}}]}})).status,400);
  const cli=spawn(process.execPath,[path.join(TOOL_ROOT,'bin/aw.mjs'),'configure','--host-config',file,'--role','designer','--effort','medium','--write'],{stdio:['ignore','pipe','pipe']});
  let diagnostic='';cli.stderr.on('data',data=>diagnostic+=data);cli.stdout.resume();
  const exit=await new Promise((resolve,reject)=>{cli.once('error',reject);cli.once('close',resolve);});assert.equal(exit,0,diagnostic);
  assert.equal(readJson(file).bindings.reviewer.effort,'medium');assert.equal(readJson(file).bindings.designer.effort,'medium');
  assert.equal((await call('/api/config',{body:{...body,revision:after.revision}})).status,409);
  const latest=await (await call('/api/config')).json();
  const concurrent=await Promise.all([
    call('/api/config',{body:{revision:latest.revision,changes:[{role:'reviewer',patch:{effort:'high'}}]}}),
    call('/api/config',{body:{revision:latest.revision,changes:[{role:'reviewer',patch:{effort:'max'}}]}})
  ]);
  assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409]);
  const models=await (await call('/api/models?provider=claude-local')).json();assert.equal(models.available,false);assert.equal(models.error,'missing_executable');assert.ok(models.models.length>0);
  assert.equal((await call('/api/run',{body:{}})).status,404);
});
