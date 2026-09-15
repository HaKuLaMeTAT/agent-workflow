import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnCli,stopChild} from '../process.mjs';
import {requireValue,processIdentity,sameProcess} from '../core.mjs';
import {environment} from './common.mjs';

// Available only under the explicitly configured full-access policy. The outer
// AW runner supervises this process tree, including native Windows descendants.
export function terminals(provider,cwd) {
  const active=new Map();
  function stop(state) {
    if(process.platform==='linux'&&!state.exitStatus&&state.child.pid) {
      const rows=[];
      for(const id of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)))try {
        const stat=fs.readFileSync(`/proc/${id}/stat`,'utf8'),tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
        rows.push({pid:Number(id),parent:Number(tail[1]),identity:processIdentity(Number(id))});
      }catch{}
      const selected=new Set([state.child.pid]);let added;
      do {added=false;for(const row of rows)if(selected.has(row.parent)&&!selected.has(row.pid)){selected.add(row.pid);added=true;}}while(added);
      for(const row of rows)if(row.pid!==state.child.pid&&selected.has(row.pid)&&sameProcess(row.identity))try{process.kill(row.pid,'SIGKILL');}catch{}
    }
    if(!state.exitStatus)stopChild(state.child,'SIGKILL');
  }
  async function handle(method,p) {
    if(method==='terminal/create') {
      requireValue(active.size<8&&typeof p.command==='string'&&p.command.length>0&&!p.command.includes('\0'),'permission_blocked','Invalid terminal command or terminal limit');
      requireValue(Array.isArray(p.args??[])&&(p.args??[]).every(x=>typeof x==='string'&&!x.includes('\0')),'permission_blocked','Invalid arguments');
      requireValue(p.cwd===undefined||(typeof p.cwd==='string'&&path.isAbsolute(p.cwd)),'permission_blocked','Terminal cwd must be absolute');
      const env=environment(provider);
      requireValue(Array.isArray(p.env??[]),'permission_blocked','Invalid terminal environment');
      for(const v of p.env??[]){requireValue(/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)&&typeof v.value==='string'&&!v.value.includes('\0'),'permission_blocked','Invalid environment variable');env[v.name]=v.value;}
      const limit=p.outputByteLimit??1024*1024;
      requireValue(Number.isInteger(limit)&&limit>=0&&limit<=4*1024*1024,'permission_blocked','Invalid outputByteLimit');
      const child=spawnCli(p.command,p.args??[],{cwd:p.cwd??cwd,env,stdio:['ignore','pipe','pipe']});
      const id=randomUUID(),state={child,session:p.sessionId,output:Buffer.alloc(0),truncated:false};
      state.done=new Promise(resolve=>{
        child.on('error',()=>{});
        // A native command may exit while an orphan still owns its output pipe.
        // Bound pipe draining; the enclosing AW runner reaps the whole group.
        let drain;
        child.once('exit',()=>{drain=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},500);});
        child.once('close',(exitCode,signal)=>{clearTimeout(drain);state.exitStatus={exitCode,signal};resolve(state.exitStatus);});
      });
      for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{
        state.output=Buffer.concat([state.output,data]);
        if(state.output.length>limit){state.truncated=true;state.output=state.output.subarray(state.output.length-limit);while(state.output.length&&(state.output[0]&0xc0)===0x80)state.output=state.output.subarray(1);}
      });
      active.set(id,state);return {terminalId:id};
    }
    const state=active.get(p.terminalId);requireValue(state&&state.session===p.sessionId,'permission_blocked','Unknown terminal');
    if(method==='terminal/output')return {output:state.output.toString('utf8'),truncated:state.truncated,...(state.exitStatus?{exitStatus:state.exitStatus}:{})};
    if(method==='terminal/wait_for_exit')return state.done;
    requireValue(['terminal/kill','terminal/release'].includes(method),'permission_blocked','Unknown terminal method');
    stop(state);await state.done;
    if(method==='terminal/release')active.delete(p.terminalId);return null;
  }
  async function close(){for(const state of active.values())stop(state);await Promise.all([...active.values()].map(s=>s.done));active.clear();}
  return {handle,close};
}
