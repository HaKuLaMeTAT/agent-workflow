import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readJson,readText,requireValue} from './core.mjs';

export function checkRuntime(directory) {
  try {
    const pkg=readJson(path.join(directory,'package.json'));
    requireValue(pkg.version==='2.25.0','upstream_version','Expected ai-cli-mcp 2.25.0');
    const marker=readJson(path.join(directory,'aw-patch.json'));
    const pinned=readJson(path.join(import.meta.dirname,'../patches/upstream.json'));
    requireValue(marker.patch_id==='aw-prepared-v2','upstream_unpatched','Apply aw-prepared-v2 first (v0.3 runtime)');
    requireValue(Object.keys(marker.sha256??{}).sort().join(',')===Object.keys(pinned.patched_sha256).sort().join(','),'upstream_unpatched','Patch file list mismatch');
    for(const [name,digest] of Object.entries(marker.sha256)) {
      requireValue(digest===pinned.patched_sha256?.[name],'upstream_changed',`Unrecognized patch digest: ${name}`);
      const actual=createHash('sha256').update(readText(path.join(directory,name),300000)).digest('hex');
      requireValue(actual===digest,'upstream_changed',`Patched file changed: ${name}`);
    }
    return {available:true,version:pkg.version,patch_id:marker.patch_id};
  } catch(e) {return {available:false,error:e.code??'runtime_unavailable',message:e.message};}
}
export async function upstreamService(host,taskDir) {
  const checked=checkRuntime(host.upstream_dir);
  requireValue(checked.available,checked.error,checked.message);
  const {CliProcessService}=await import(pathToFileURL(path.join(host.upstream_dir,'dist/cli-process-service.js')));
  const service=new CliProcessService({stateDir:path.join(taskDir,'upstream'),cliPaths:{claude:'',codex:'',gemini:'',forge:'',opencode:''}});
  requireValue(typeof service.startPreparedProcess==='function','upstream_unpatched','Prepared process hook missing');
  return service;
}
