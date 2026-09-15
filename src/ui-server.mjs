import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {loadHost} from './config.mjs';
import {configurationSnapshot,editBindings} from './config-editor.mjs';
import {discover} from './adapter.mjs';
import {fields,text,requireValue,integer,hash} from './core.mjs';

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8'};
async function jsonBody(req) {
  requireValue(req.headers['content-type']?.split(';')[0]==='application/json','invalid_input','Expected application/json');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;requireValue(size<=128*1024,'input_too_large','Configuration request is too large');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{requireValue(false,'invalid_json','Request body is not valid JSON');}
}
export async function startUi({hostConfig,port=0,cwd=process.cwd()}={}) {
  requireValue(process.env.AW_WORKER!=='1','delegation_forbidden','Read-only workers cannot start a configuration editor');
  integer(port,0,65535,'port');
  const hostFile=loadHost(hostConfig).hostFile,token=randomBytes(32).toString('hex'),pending=new Map();
  const uiRoot=path.resolve(import.meta.dirname,'../ui'),assets=new Map();
  for(const file of ['index.html','style.css','app.mjs'])assets.set(file==='index.html'?'/':`/${file}`,{body:fs.readFileSync(path.join(uiRoot,file)),type:MIME[path.extname(file)]});
  let address;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const host=req.headers.host,hosts=[`127.0.0.1:${address.port}`,`localhost:${address.port}`];
      requireValue(hosts.includes(host),'forbidden','请使用启动命令显示的本地地址。');
      requireValue(!req.headers.origin||req.headers.origin===`http://${host}`,'forbidden','Cross-origin access is not allowed');
      requireValue(!['cross-site','same-site'].includes(req.headers['sec-fetch-site']),'forbidden','Cross-origin access is not allowed');
      const url=new URL(req.url,`http://${host}`),asset=assets.get(url.pathname);
      if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset.type});res.end(asset.body);return;}
      const supplied=req.headers.authorization??'',expected=`Bearer ${token}`;
      requireValue(Buffer.byteLength(supplied)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)),'unauthorized','访问链接已失效或缺少凭据。请用 aw ui 显示的完整链接重新打开。');
      if(req.method==='GET'&&url.pathname==='/api/config'){send(200,configurationSnapshot(hostFile).view);return;}
      if(req.method==='GET'&&url.pathname==='/api/models') {
        const h=loadHost(hostFile),provider=url.searchParams.get('provider');
        requireValue(Object.hasOwn(h.providers,provider),'invalid_input','Unknown provider');
        const refresh=url.searchParams.get('refresh')==='1',key=hash({provider:h.providers[provider],refresh});
        if(!pending.has(key))pending.set(key,discover(h,provider,{cwd,catalog:true,refresh}).finally(()=>pending.delete(key)));
        const result=await pending.get(key);
        send(200,{provider,available:result.available,error:result.error??result.catalog_error,models:result.models??[],cached:result.cached,checked_at:result.checked_at});return;
      }
      if(req.method==='POST'&&['/api/preview','/api/config'].includes(url.pathname)) {
        const body=await jsonBody(req);fields(body,['revision','changes'],'request');text(body.revision,'revision');
        const out=await editBindings(hostFile,{...body,write:url.pathname==='/api/config'});
        send(200,url.pathname==='/api/config'?out.snapshot:{revision:out.revision,changes:out.changes});return;
      }
      send(404,{error:'not_found',message:'Unknown configuration endpoint'});
    }catch(e){
      if(res.destroyed)return;
      const status=e.code==='unauthorized'?401:e.code==='forbidden'?403:e.code==='config_conflict'?409:e.code==='input_too_large'?413:e.code==='busy'?409:e.code?400:500;
      send(status,{error:e.code??'internal_error',message:e.code?e.message:'Unable to complete configuration request'});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=2000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{address=server.address();resolve();});});
  const origin=`http://127.0.0.1:${address.port}`;
  return {server,origin,url:`${origin}/#token=${token}`,hostFile,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
