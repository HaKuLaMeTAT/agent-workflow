import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readJson,atomicJson,requireValue} from '../src/core.mjs';
const patchRoot=path.resolve(import.meta.dirname,'../patches');
const digest=s=>createHash('sha256').update(s).digest('hex');
function replaceOnce(source,before,after) {
  requireValue(source.split(before).length===2,'patch_conflict','Expected upstream patch location exactly once');
  return source.replace(before,after);
}
export function applyUpstreamPatch(target) {
  const pinned=readJson(path.join(patchRoot,'upstream.json')), pkg=readJson(path.join(target,'package.json'));
  requireValue(pkg.version===pinned.version,'upstream_version','Expected ai-cli-mcp 2.25.0');
  let service=fs.readFileSync(path.join(target,'dist/cli-process-service.js'),'utf8');
  const runner=fs.readFileSync(path.join(target,'dist/detached-runner.cjs'),'utf8');
  const markerFile=path.join(target,'aw-patch.json');
  if(fs.existsSync(markerFile)) {
    const m=readJson(markerFile);
    requireValue(m.patch_id==='aw-prepared-v1' && m.sha256?.['dist/cli-process-service.js']===digest(service) && m.sha256?.['dist/detached-runner.cjs']===digest(runner),'patch_conflict','Installed patch differs; do not overwrite it');
    for(const [name,expected] of Object.entries(pinned.patched_sha256))requireValue(m.sha256[name]===expected,'patch_conflict','Installed digest is not the pinned patch');
    return {status:'already_applied',...m};
  }
  for(const [name,expected] of Object.entries(pinned.original_sha256))requireValue(digest(fs.readFileSync(path.join(target,name)))===expected,'patch_conflict',`Unexpected upstream bytes: ${name}`);
  service=replaceOnce(service,'    async startDetachedTrackedProcess(cmd, model) {',`    // agent-workflow: dispatch an explicit adapter command through the existing runner.
    async startPreparedProcess(cmd, preparedFile) {
        return this.startDetachedTrackedProcess(cmd, cmd.resolvedModel, preparedFile);
    }
    async startDetachedTrackedProcess(cmd, model, preparedFile) {`);
  service=replaceOnce(service,'[runnerPath, this.stateDir, cwdKey, cmd.cliPath, ...cmd.args], {\n            cwd: cmd.cwd,',`[runnerPath, this.stateDir, cwdKey, cmd.cliPath, ...cmd.args], {
            env: preparedFile ? {...process.env, AW_PREPARED_COMMAND: preparedFile} : process.env,
            cwd: cmd.cwd,`);
  const patchedRunner=fs.readFileSync(path.join(patchRoot,'detached-runner.cjs'),'utf8');
  const marker={patch_id:'aw-prepared-v1',upstream_version:pinned.version,sha256:{'dist/cli-process-service.js':digest(service),'dist/detached-runner.cjs':digest(patchedRunner)}};
  for(const [name,expected] of Object.entries(pinned.patched_sha256))requireValue(marker.sha256[name]===expected,'patch_conflict','Generated patch differs from pinned digest');
  fs.writeFileSync(path.join(target,'dist/cli-process-service.js'),service);
  fs.writeFileSync(path.join(target,'dist/detached-runner.cjs'),patchedRunner);
  atomicJson(markerFile,marker);
  return {status:'applied',...marker};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {requireValue(process.argv.length===3,'invalid_input','Usage: node scripts/patch-upstream.mjs UPSTREAM_DIR');console.log(JSON.stringify(applyUpstreamPatch(path.resolve(process.argv[2])),null,2));}
  catch(e){console.error(JSON.stringify({error:e.code ?? 'patch_error',message:e.message}));process.exitCode=1;}
}
