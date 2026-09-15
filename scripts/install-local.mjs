// Review docs/INSTALL.md first. This script does not install npm dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readJson,requireValue} from '../src/core.mjs';
import {loadHost,TOOL_ROOT} from '../src/config.mjs';
import {upstreamService} from '../src/adapter.mjs';
try {
  requireValue(process.argv[2]==='--apply' && process.argv[3], 'usage', 'node scripts/install-local.mjs --apply HOST_SOURCE');
  requireValue(process.platform==='linux','platform_unverified','Linux/WSL only');
  const source=path.resolve(process.argv[3]), h=loadHost(source), home=os.homedir();
  const config=readJson(source);
  config.catalog=path.resolve(path.dirname(source),config.catalog);config.upstream_dir=h.upstream_dir;config.state_dir=h.state_dir;
  const hostFile=path.join(home,'.config/agent-workflow/host.json'), bin=path.join(home,'.local/bin/aw');
  const skill=path.join(home,'.codex/skills/agent-workflow');
  for(const file of [hostFile,bin,skill])requireValue(!fs.existsSync(file) && !fs.lstatSync(file,{throwIfNoEntry:false}), 'already_exists', `Refusing to replace ${file}`);
  // Verify the exact patched runtime before creating an entrypoint.
  const probe=fs.mkdtempSync(path.join(os.tmpdir(),'aw-install-check-'));
  try {await upstreamService(h,probe);}finally{fs.rmSync(probe,{recursive:true,force:true});}
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const wrapper=`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(TOOL_ROOT,'bin/aw.mjs'))} "$@"\n`;
  for(const file of [hostFile,bin,skill])fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(hostFile,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(bin,wrapper,{flag:'wx',mode:0o700});
  fs.symlinkSync(path.join(TOOL_ROOT,'skills/agent-workflow'),skill);
  console.log(JSON.stringify({host_config:hostFile,cli:bin,skill,runtime:h.upstream_dir},null,2));
}catch(e){console.error(JSON.stringify({error:e.code??'install_error',message:e.message}));process.exitCode=1;}
