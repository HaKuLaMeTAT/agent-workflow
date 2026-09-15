import spawn from './spawn.cjs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const spawnCli=spawn;
export function stopChild(child,signal='SIGTERM') {
  if(!child.pid || child.exitCode!==null || child.signalCode!==null)return;
  if(process.platform==='win32') {
    spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true,timeout:10000});
  }else child.kill(signal);
}
