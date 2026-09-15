import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AwError,requireValue} from '../core.mjs';
const exec=promisify(execFile);
export function executable(command) {
  const candidates=path.isAbsolute(command)?[command]:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,command));
  for(const candidate of candidates) {
    try {fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return fs.realpathSync(candidate);}catch{}
  }
  return null;
}
export function environment(provider) {
  const env={};
  for(const key of ['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','PATH',...(provider.inherit_env??[])])if(process.env[key])env[key]=process.env[key];
  env.PATH=[path.dirname(provider.executable),path.dirname(process.execPath),env.PATH].filter(Boolean).join(path.delimiter);
  env.AW_WORKER='1';
  return env;
}
export async function command(provider,args,{cwd,env,timeout=12000,maxBuffer=4*1024*1024}={}) {
  try {
    return await exec(provider.executable,[...(provider.args??[]),...args],{cwd,env:env??environment(provider),encoding:'utf8',timeout,maxBuffer});
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
