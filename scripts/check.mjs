import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readJson} from '../src/core.mjs';
const root=path.resolve(import.meta.dirname,'..');let count=0;
for(const folder of ['bin','src','src/adapters','ui','scripts','tests','tests/fixtures','patches','config']) {
  for(const entry of fs.readdirSync(path.join(root,folder),{withFileTypes:true})) {
    if(!entry.isFile() || entry.name.endsWith('.local.json'))continue;
    const file=path.join(root,folder,entry.name);
    if(/\.(mjs|cjs)$/.test(file)) {const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(r.status??1);}count++;}
    if(file.endsWith('.json')){readJson(file);count++;}
  }
}
console.log(`Validated ${count} JavaScript/JSON files.`);
