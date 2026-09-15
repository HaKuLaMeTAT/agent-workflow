// Shared by the host and the pinned detached runner. No npm dependencies.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function powershell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script=`try { $p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { exit 1 }`;
      const r=spawnSync(powershell(),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
      if(r.status!==0 || !/^\d+$/.test(r.stdout.trim()))return null;
      return {pid,start_time:r.stdout.trim()};
    }
    if(process.platform!=='linux')return null;
    const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    const parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');
    if(parts[0]==='Z')return null;
    return {pid,start_ticks:parts[19],boot_id:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
  } catch {return null;}
}
module.exports={powershell,processIdentity};
