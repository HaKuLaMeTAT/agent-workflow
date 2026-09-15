import fs from 'node:fs';
import path from 'node:path';
import {spawnCli,stopChild} from '../process.mjs';
import {AwError,requireValue} from '../core.mjs';
const envValue=key=>process.env[Object.keys(process.env).find(k=>process.platform==='win32'?k.toUpperCase()===key.toUpperCase():k===key)];
export function executable(command) {
  const windows=process.platform==='win32';
  const extensions=(envValue('PATHEXT')||'.COM;.EXE;.BAT;.CMD').split(';').filter(x=>/^\.[a-z0-9]+$/i.test(x));
  const names=windows&&!extensions.some(ext=>command.toLowerCase().endsWith(ext.toLowerCase()))?extensions.map(ext=>command+ext):[command];
  const candidates=path.isAbsolute(command)?names:(envValue('PATH')??'').split(path.delimiter).filter(Boolean).flatMap(dir=>names.map(name=>path.join(dir.replace(/^"|"$/g,''),name)));
  for(const candidate of candidates) {
    try {fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return fs.realpathSync(candidate);}catch{}
  }
  return null;
}
export function environment(provider) {
  const env={};
  for(const key of ['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','PATH','CODEX_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','WINDIR','ComSpec','PATHEXT','TEMP','TMP','HOMEDRIVE','HOMEPATH',...(provider.inherit_env??[])])if(envValue(key))env[key]=envValue(key);
  env.PATH=[path.dirname(provider.executable),path.dirname(process.execPath),env.PATH].filter(Boolean).join(path.delimiter);
  env.AW_WORKER='1';
  return env;
}
export async function command(provider,args,{cwd,env,timeout=12000,maxBuffer=4*1024*1024}={}) {
  try {
    return await new Promise((resolve,reject)=>{
      const child=spawnCli(provider.executable,[...(provider.args??[]),...args],{cwd,env:env??environment(provider),stdio:['ignore','pipe','pipe']});
      const output={stdout:[],stderr:[]};let bytes=0,failure;
      const stop=code=>{failure??=new AwError(code,code);stopChild(child,'SIGKILL');};
      const timer=setTimeout(()=>stop('probe_timeout'),timeout);
      for(const key of ['stdout','stderr'])child[key].on('data',data=>{bytes+=data.length;if(bytes>maxBuffer)stop('output_too_large');else output[key].push(data);});
      child.once('error',error=>{failure=error;});
      child.once('close',(code,signal)=>{
        clearTimeout(timer);
        if(failure||code!==0)reject(failure??new AwError(signal??String(code),'CLI exited'));
        else resolve(Object.fromEntries(Object.entries(output).map(([key,chunks])=>[key,Buffer.concat(chunks).toString('utf8')])));
      });
    });
  }catch(e){throw new AwError('probe_failed',`CLI probe failed (${e.code??e.signal??'unknown'}); no model task was submitted`);}
}
export function declaredModels(provider) {
  return Object.entries(provider.models??{}).map(([id,efforts])=>({id,efforts,source:'configured',verified:false}));
}
export function parseObject(text) {
  const body=String(text??'').trim().replace(/^```(?:json)?\s*\n?/,'').replace(/\n?```$/,'');
  try {return JSON.parse(body);}catch{throw new AwError('invalid_result','Final result is not JSON');}
}
export async function events(file) {
  if(!fs.existsSync(file))return [];
  requireValue(fs.statSync(file).size<=16*1024*1024,'output_too_large','Transcript exceeds 16 MiB; retained on disk');
  const {createInterface}=await import('node:readline');const output=[];
  for await(const line of createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})) {
    requireValue(line.length<=2*1024*1024,'output_too_large','Single event exceeds 2 MiB');
    try {output.push(JSON.parse(line));}catch{}
  }
  return output;
}
export function errorCode(detail) {
  const text=String(detail??'');
  if(/rate.?limit|quota|usage.?limit|hit.*limit|exceeded.*limit/i.test(text))return 'quota_exhausted';
  if(/auth|login|log in|invalid.?token|unauthorized/i.test(text))return 'authentication_required';
  if(/permission|denied|not allowed/i.test(text))return 'permission_blocked';
  if(/model.*(?:unknown|unsupported|not found)/i.test(text))return 'unsupported_model';
  return 'provider_error';
}
export function usage(value) {
  if(!value)return null;
  const normalized={...value,cache_read_input_tokens:value.cache_read_input_tokens??value.cached_input_tokens};
  return Object.fromEntries(['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'].map(k=>[k,Number.isFinite(normalized[k])?normalized[k]:null]));
}
export function baseObservation() {return {session_id:null,model:null,tools:null,reads:[],data:null,error:null,final:false,usage:null,estimated_cost_usd:null};}
export function permissionShape(access) {
  requireValue(access==='read-only','permission_unsupported','Only read-only worker policies are implemented');
}
// JSON objects separated by model-ID lines (OpenCode models --verbose).
export function jsonObjects(source) {
  const results=[];let start=-1,depth=0,quoted=false,escaped=false;
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'&&depth){quoted=true;continue;}
    if(c==='{'){if(depth++===0)start=i;}
    if(c==='}'&&depth&&--depth===0){try{results.push({prefix:source.slice(0,start).trim().split('\n').at(-1),value:JSON.parse(source.slice(start,i+1))});}catch{}}
  }
  return results;
}
