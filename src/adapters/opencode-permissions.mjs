import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {requireValue} from '../core.mjs';

// OpenCode 1.18.31 resolves the nearest .git marker, then asks for paths
// relative to that worktree (including linked worktrees). Non-Git uses '/'.
export function permissionBase(cwd,env) {
  let directory=path.resolve(cwd);
  for(;;) {
    if(fs.existsSync(path.join(directory,'.git'))) {
      const r=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:directory,env,encoding:'utf8',timeout:10000,windowsHide:true});
      requireValue(!r.error&&r.status===0&&r.stdout.trim(),'permission_base_unknown','Cannot establish the OpenCode Git permission base');
      return path.resolve(directory,r.stdout.trim());
    }
    const parent=path.dirname(directory);if(parent===directory)return '/';directory=parent;
  }
}
export function pathPermissions(cwd,base,names,paths=path) {
  const rules={'*':'deny'};
  // On Windows '/' resolves on the child's current drive, not AW's drive.
  const root=base==='/'?paths.parse(cwd).root:base;
  for(const name of names) {
    const absolute=paths.resolve(cwd,name),relative=paths.relative(root,absolute).replaceAll('\\','/');
    requireValue(!/[?*]/.test(relative),'permission_path_unsupported','OpenCode permission paths cannot contain wildcard characters');
    rules[relative]='allow';rules[relative?`${relative}/*`:'*']='allow';
  }
  return rules;
}
export function scopedPermissions(snapshot,env) {
  if(!snapshot)return {'*':'deny'};
  const base=permissionBase(snapshot.cwd,env),writes=snapshot.role.access==='workspace-write'?snapshot.execution?.write_paths??[]:[];
  const reads=[...(snapshot.request?.read_paths??[]),...writes];
  // glob/grep match the search expression, not the searched directory. They
  // cannot enforce a path allowlist. Declared directories can use read instead.
  return {'*':'deny',external_directory:'deny',glob:'deny',grep:'deny',list:'deny',
    read:pathPermissions(snapshot.cwd,base,reads),edit:pathPermissions(snapshot.cwd,base,writes)};
}
