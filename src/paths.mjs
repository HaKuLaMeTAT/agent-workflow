import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function userPaths({platform=process.platform,home=os.homedir(),env=process.env}={}) {
  const p=platform==='win32'?path.win32:path.posix;
  const base=platform==='win32'?p.join(env.LOCALAPPDATA||p.join(home,'AppData','Local'),'agent-workflow'):p.join(home,'.config','agent-workflow');
  const legacySkill=p.join(home,'.codex','skills','agent-workflow');
  return {
    host:p.join(base,'host.json'),
    state:platform==='win32'?p.join(base,'state'):p.join(home,'.local','state','agent-workflow'),
    bin:platform==='win32'?p.join(base,'bin'):p.join(home,'.local','bin'),
    skill:env.CODEX_HOME?p.join(env.CODEX_HOME,'skills','agent-workflow'):
      fs.lstatSync(legacySkill,{throwIfNoEntry:false})?legacySkill:p.join(home,'.agents','skills','agent-workflow'),
  };
}
