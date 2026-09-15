import fs from 'node:fs';
import path from 'node:path';
import {TOOL_ROOT} from '../../src/config.mjs';
export function providerFixture(root) {
  const script=path.join(root,'provider.mjs');
  fs.copyFileSync(path.join(TOOL_ROOT,'tests/fixtures/provider.mjs'),script);
  if(process.platform==='win32') {
    const file=path.join(root,'provider.cmd');
    fs.writeFileSync(file,`@echo off\r\n"${process.execPath.replaceAll('%','%%')}" "%~dp0provider.mjs" %*\r\n`);
    return file;
  }
  fs.chmodSync(script,0o700);return script;
}
export function runtimeFixture(upstream,target) {
  // Force Node's JS copy traversal: native Windows 22.x cp can skip Unicode targets.
  fs.cpSync(upstream,target,{recursive:true,filter:()=>true});
  // The upstream Windows runner resolves cross-spawn locally.
  fs.cpSync(path.join(TOOL_ROOT,'node_modules'),path.join(target,'node_modules'),{recursive:true,filter:source=>path.basename(source)!=='.bin'});
}
