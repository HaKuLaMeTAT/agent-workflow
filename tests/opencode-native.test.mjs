// Opt-in: actual OpenCode tools and permission matcher, deterministic local
// model transport. No account credentials or paid model requests are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {opencode} from '../src/adapters/opencode.mjs';
import {command,events} from '../src/adapters/common.mjs';
import {git} from '../src/workspaces.mjs';

const executable=process.env.AW_TEST_OPENCODE;
for(const mode of ['directory','git-worktree'])test(`native OpenCode ${mode}: allowed write/read, missing target, sibling and outside denied`,{skip:!executable,timeout:120000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw native 中文 space-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let cwd=path.join(root,'output');fs.mkdirSync(cwd);
  if(mode==='git-worktree') {
    git(cwd,['init']);git(cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','base']);
    const linked=path.join(root,'linked');git(cwd,['worktree','add','--detach',linked]);cwd=path.join(linked,'nested');fs.mkdirSync(cwd);
  }
  fs.writeFileSync(path.join(cwd,'secret.txt'),'UNAUTHORIZED_SECRET');
  const allowed=path.join(cwd,'out','aw-migration.txt'),sibling=path.join(cwd,'out','sibling.txt'),outside=path.join(root,'escape.txt');
  const calls=[
    ['read',{filePath:allowed}],
    ['write',{filePath:allowed,content:'AW_DIRECTORY_OK'}],
    ['read',{filePath:allowed}],
    ['write',{filePath:sibling,content:'DENIED'}],
    ['write',{filePath:outside,content:'DENIED'}],
    ['read',{filePath:path.join(cwd,'secret.txt')}]
  ];
  let requests=0;const failures=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    try {
      assert.equal(req.url,'/chat/completions');const input=JSON.parse(body);
      const index=requests++;assert.ok(index<=calls.length,'unexpected extra model request');
      assert.ok(!JSON.stringify(input.messages).includes('UNAUTHORIZED_SECRET'),'unauthorized content reached the model');
      const call=calls[index],delta=call?{role:'assistant',tool_calls:[{index:0,id:`call_${index}`,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{role:'assistant',content:'{"summary":"native permissions checked"}'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      const chunk=(delta,finish_reason=null,usage)=>({id:`response_${index}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})});
      res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({},call?'tool_calls':'stop',{prompt_tokens:10,completion_tokens:5,total_tokens:15}))}\n\n`);
      res.end('data: [DONE]\n\n');
    }catch(e){failures.push(e.message);res.writeHead(500);res.end('fixture rejected request');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const provider={executable,adapter:'opencode'},snapshot={cwd,provider,model:'aw-fixture/fixture',effort:null,remaining_budget:{max_model_turns:10},role:{access:'workspace-write',permissions:'restricted'},request:{read_paths:[]},execution:{write_paths:['out/aw-migration.txt']}};
  const c=opencode.prepare(snapshot,{directory:root,prompt:path.join(root,'prompt')});
  const config=JSON.parse(c.env.OPENCODE_CONFIG_CONTENT);
  config.agent.title={disable:true};config.agent.summary={disable:true};config.agent.compaction={disable:true};
  config.provider={'aw-fixture':{npm:'@ai-sdk/openai-compatible',name:'Local permission fixture',options:{baseURL:`http://127.0.0.1:${server.address().port}`,apiKey:'local-fixture'},models:{fixture:{name:'Fixture',limit:{context:32000,output:2000}}}}};
  config.enabled_providers=['aw-fixture'];
  Object.assign(c.env,{OPENCODE_CONFIG_CONTENT:JSON.stringify(config),XDG_DATA_HOME:path.join(root,'data'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_STATE_HOME:path.join(root,'state'),OPENCODE_DISABLE_MODELS_FETCH:'1'});
  const output=await command(provider,[...c.args,'Exercise the requested fixture tool calls.'],{cwd,env:c.env,timeout:110000});
  assert.deepEqual(failures,[]);assert.equal(requests,calls.length+1);
  const log=path.join(root,'stdout.jsonl');fs.writeFileSync(log,output.stdout);
  const tools=(await events(log)).filter(e=>e.type==='tool_use').map(e=>e.part);
  assert.equal(tools.length,calls.length,JSON.stringify(tools.map(p=>({id:p.callID,tool:p.tool,status:p.state.status,error:p.state.error})))+output.stderr.slice(-1000));
  assert.match(tools[0].state.error,/not found|does not exist/i);assert.doesNotMatch(tools[0].state.error,/permission|rejected/i);
  assert.equal(tools[1].state.status,'completed');assert.equal(tools[2].state.status,'completed');assert.match(tools[2].state.output,/AW_DIRECTORY_OK/);
  for(const p of tools.slice(3)){assert.equal(p.state.status,'error');assert.match(p.state.error,/permission|denied|rejected/i);}
  assert.equal(fs.readFileSync(allowed,'utf8'),'AW_DIRECTORY_OK');assert.equal(fs.existsSync(sibling),false);assert.equal(fs.existsSync(outside),false);
});
