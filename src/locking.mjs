import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {AwError,requireValue} from './core.mjs';
import platform from './platform.cjs';

// flock owns the kernel lock; a crashed caller closes stdin and releases the holder.
// The lock inode is never deleted or replaced, avoiding stale-owner/unlink races.
export async function withFileLock(file,fn) {
  requireValue(['linux','win32'].includes(process.platform),'platform_unverified','Task locking supports Linux/WSL and Windows');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(process.platform==='linux'){const fd=fs.openSync(file,'a',0o600);fs.closeSync(fd);}
  const windows=process.platform==='win32';
  const child=spawn(windows?platform.powershell():'flock',windows?
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(import.meta.dirname,'../scripts/windows-lock.ps1'),file]:
    ['--exclusive','--timeout','10',file,process.execPath,path.join(import.meta.dirname,'lock-holder.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stdin.on('error',()=>{});
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  try {
    await new Promise((resolve,reject)=>{
      let ready=false;
      child.once('error',e=>reject(new AwError('lock_unavailable',`Cannot start lock holder: ${e.code}`)));
      child.stdout.once('data',()=>{ready=true;resolve();});
      child.once('close',()=>{if(!ready)reject(new AwError('busy','Timed out acquiring task lock'));});
    });
    return await fn();
  } finally {child.stdin.end();await closed;}
}
