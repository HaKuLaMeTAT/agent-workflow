import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadHost,TOOL_ROOT} from '../src/config.mjs';
import {routeTask} from '../src/routing.mjs';
import {readJson,atomicJson} from '../src/core.mjs';
import {editBindings,configurationSnapshot} from '../src/config-editor.mjs';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw-routing-')),file=path.join(root,'host.json'),raw=readJson(path.join(TOOL_ROOT,'config/home.example.json'));
  raw.catalog=path.join(TOOL_ROOT,'config/roles.json');raw.state_dir=path.join(root,'state');raw.routing={enabled:true};
  for(const id of ['developer-basic','developer-main','developer-hard','executor'])raw.bindings[id]={enabled:true,execution:'worker',access:'workspace-write',provider:'claude-local',model:'claude-sonnet-5',effort:'high'};
  atomicJson(file,raw);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,file,h:loadHost(file)};
}
test('routing: host judgment maps to configurable roles without spawning tasks or changing models',t=>{
  const {root,h}=fixture(t);
  assert.equal(routeTask(h,root,{kind:'conversation'}).action,'host');assert.equal(routeTask(h,root,{kind:'code',complexity:'trivial'}).action,'host');
  for(const [input,role] of [[{kind:'code',complexity:'simple'},'developer-basic'],[{kind:'code'},'developer-main'],[{kind:'code',complexity:'complex'},'developer-hard'],[{kind:'artifact'},'executor'],[{kind:'design'},'designer'],[{kind:'review',complexity:'trivial'},'reviewer'],[{kind:'analysis'},'analyst-primary']]) {
    const selected=routeTask(h,root,input);assert.equal(selected.role,role);assert.equal(selected.selected.model,selected.action==='host'?null:h.bindings[role].model);
  }
  assert.equal(routeTask(h,root,{kind:'artifact'}).suggested_workspace,'directory');assert.equal(routeTask(h,root,{kind:'code'}).suggested_workspace,'git-worktree');
  assert.equal(routeTask(h,root,{kind:'code',complexity:'simple',failed_attempts:2}).role,'developer-main');
  assert.equal(routeTask(h,root,{kind:'code',failed_attempts:2}).role,'developer-hard');
  assert.equal(routeTask(h,root,{kind:'code',complexity:'complex',failed_attempts:2}).action,'host');
  assert.equal(routeTask(h,root,{kind:'code',delegations:3}).reason,'delegation_budget_reached');
  assert.equal(fs.existsSync(path.join(h.state_dir,'tasks')),false);
});

test('routing defaults: basic/main stay in the host with no model binding; failures reach an external upgrade role',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw-host-route-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const h=loadHost(path.join(TOOL_ROOT,'config/home.example.json'));
  for(const complexity of ['simple','standard']) {
    const selected=routeTask(h,root,{kind:'code',complexity});
    assert.equal(selected.action,'host');assert.equal(selected.selected.model,null);assert.equal(selected.selected.provider,null);assert.equal(selected.selected.permissions,null);assert.equal(selected.suggested_workspace,null);
    assert.equal(routeTask(h,root,{kind:'code',complexity,failed_attempts:2}).role,'developer-hard');
  }
  assert.equal(routeTask(h,root,{kind:'code',complexity:'complex'}).action,'worker');
  h.bindings['developer-basic']={enabled:true,execution:'host',provider:'codex-local',model:'legacy-model',effort:'low'};
  assert.equal(routeTask(h,root,{kind:'code',complexity:'simple'}).selected.model,null);
});
test('routing: opt-out, unavailable roles, project limits and user-selected bindings are respected',async t=>{
  const {root,file,h}=fixture(t);
  h.bindings.executor.enabled=false;assert.equal(routeTask(h,root,{kind:'artifact'}).reason,'role_unavailable');h.bindings.executor.enabled=true;
  atomicJson(path.join(root,'agent-workflow.json'),{schema_version:1,allowed_roles:['reviewer'],instructions:[]});
  assert.equal(routeTask(h,root,{kind:'code'}).reason,'role_not_allowed');fs.unlinkSync(path.join(root,'agent-workflow.json'));
  const before=configurationSnapshot(file),preview=await editBindings(file,{revision:before.revision,routing:{enabled:false}});
  assert.equal(loadHost(file).routing.enabled,true);assert.equal(preview.changes[0].after,false);
  await editBindings(file,{revision:before.revision,routing:{enabled:false},write:true});assert.equal(routeTask(loadHost(file),root,{kind:'artifact'}).reason,'automatic_routing_disabled');
  await editBindings(file,{routing:{enabled:true,roles:{code_simple:'executor'}},changes:[{role:'executor',patch:{provider:'codex-local',model:'user-chosen-model',effort:'low'}}],write:true});
  assert.equal(routeTask(loadHost(file),root,{kind:'code',complexity:'simple'}).selected.model,'user-chosen-model');
  await assert.rejects(editBindings(file,{routing:{roles:{code_simple:'unknown'}},write:true}),{code:'invalid_config'});
  const raw=readJson(file);delete raw.routing;atomicJson(file,raw);assert.equal(loadHost(file).routing.enabled,false);
  const catalog=readJson(path.join(TOOL_ROOT,'config/roles.json'));catalog.roles={reviewer:{...catalog.roles.reviewer,instructions:path.join(TOOL_ROOT,'roles/reviewer.md')}};
  atomicJson(path.join(root,'catalog.json'),catalog);raw.catalog=path.join(root,'catalog.json');raw.bindings={reviewer:raw.bindings.reviewer};atomicJson(file,raw);
  assert.equal(loadHost(file).routing.enabled,false,'Legacy custom catalogs do not need built-in routing roles');
});
