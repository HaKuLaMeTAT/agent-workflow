#!/usr/bin/env node
// Installed beside SKILL.md. Paths are data, never interpolated into shell code.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
try {
  const file=path.join(import.meta.dirname,'installation.json');
  const installed=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const root=process.env.AW_ROOT||installed?.tool_root||path.resolve(import.meta.dirname,'../..');
  const entry=path.join(root,'bin','aw.mjs');
  if(!fs.existsSync(entry))throw new Error('Agent Workflow checkout moved or is missing. Run node scripts/install-local.mjs --apply --update from its new location.');
  if(!process.env.AW_HOST_CONFIG&&installed)process.env.AW_HOST_CONFIG=installed.host_config;
  process.argv=[process.execPath,entry,...process.argv.slice(2)];
  await import(pathToFileURL(entry).href);
}catch(error){console.error(JSON.stringify({error:'installation_unavailable',message:error.message}));process.exitCode=1;}
