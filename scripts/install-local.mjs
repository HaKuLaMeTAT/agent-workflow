// Validates a prepared local runtime; does not install packages or call models.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readJson,requireValue,within,atomicJson} from '../src/core.mjs';
import {parseHost,TOOL_ROOT} from '../src/config.mjs';
import {userPaths} from '../src/paths.mjs';
import {upstreamService} from '../src/adapter.mjs';
import {withFileLock} from '../src/locking.mjs';

const exists=file=>Boolean(fs.lstatSync(file,{throwIfNoEntry:false}));
const sh=s=>"'"+s.replaceAll("'","'\\''")+"'";
const ps=s=>"'"+s.replaceAll("'","''")+"'";
export async function installLocal({source,update=false,hostFile=userPaths().host,binDir=userPaths().bin,skillDir=userPaths().skill,root=TOOL_ROOT}={}) {
  requireValue(['linux','win32'].includes(process.platform),'platform_unverified','Supports Linux/WSL and Windows');
  root=fs.realpathSync(root);hostFile=path.resolve(hostFile);binDir=path.resolve(binDir);skillDir=path.resolve(skillDir);
  return withFileLock(`${hostFile}.install.lock`,async()=>{
    const manifestFile=path.join(skillDir,'installation.json');
    const previous=exists(manifestFile)?readJson(manifestFile):null;
    let legacy=false;
    if(exists(skillDir)&&fs.lstatSync(skillDir).isSymbolicLink()) {
      const target=path.resolve(path.dirname(skillDir),fs.readlinkSync(skillDir));
      legacy=target===path.join(root,'skills','agent-workflow');
    }
    const managed=previous?.managed_by==='agent-workflow'&&previous.schema_version===1;
    const cli=path.join(binDir,process.platform==='win32'?'aw.cmd':'aw');
    const launcher=path.join(skillDir,'aw.mjs');
    requireValue(!within(path.join(root,'skills','agent-workflow'),skillDir),'invalid_install_path','Install the user skill outside the source skill directory');
    if(update) {
      requireValue(managed||legacy||(!exists(skillDir)&&!exists(cli)&&!exists(hostFile)),'not_managed','Cannot update an unrecognized installation');
      if(managed)requireValue(previous.host_config===hostFile&&previous.cli===cli,'installation_conflict','Use the host, bin and skill locations of the existing installation');
      if(legacy&&exists(cli)) {
        const expected=`#!/bin/sh\nexec ${sh(process.execPath)} ${sh(path.join(root,'bin/aw.mjs'))} "$@"\n`;
        requireValue(fs.readFileSync(cli,'utf8')===expected,'not_managed','Legacy aw entrypoint differs; choose another --bin-dir');
      }
    }else for(const file of [hostFile,cli,skillDir])requireValue(!exists(file),'already_exists',`Already exists: ${file}; use --update for a managed installation`);
    const input=path.resolve(source||(update&&exists(hostFile)?hostFile:''));
    requireValue(source||(update&&exists(hostFile)),'usage','Pass a host source, or --update to keep the installed configuration');
    const config=readJson(input),oldRoot=managed?previous.tool_root:null;
    // Re-register tool-owned paths after moving a checkout; external paths stay explicit.
    for(const key of ['catalog','upstream_dir','state_dir'])if(config[key]) {
      let value=path.resolve(path.dirname(input),config[key]);
      if(oldRoot&&within(oldRoot,value))value=path.join(root,path.relative(oldRoot,value));
      config[key]=value;
    }
    if(!config.upstream_dir)config.upstream_dir=path.join(root,'.runtime','node_modules','ai-cli-mcp');
    const h=parseHost(input,config);config.state_dir=h.state_dir;
    const probe=fs.mkdtempSync(path.join(os.tmpdir(),'aw-install-check-'));
    try {await upstreamService(h,probe);}finally{fs.rmSync(probe,{recursive:true,force:true});}
    const manifest={schema_version:1,managed_by:'agent-workflow',version:readJson(path.join(root,'package.json')).version,tool_root:root,node:process.execPath,host_config:hostFile,cli};
    const invocation=process.platform==='win32'?`& ${ps(process.execPath)} ${ps(launcher)}`:`${sh(process.execPath)} ${sh(launcher)}`;
    const baseSkill=fs.readFileSync(path.join(root,'skills','agent-workflow','SKILL.md'),'utf8');
    const skill=baseSkill.replace('<!-- installation -->',`## Installed entrypoint\n\nUse this exact command prefix from any working directory (${process.platform==='win32'?'PowerShell':'POSIX shell'}):\n\n\`\`\`\n${invocation}\n\`\`\`\n\nAppend aw arguments, for example \`roles\` or \`prepare --role reviewer --cwd PROJECT\`. The launcher reads [installation.json](installation.json), including the registered host configuration. No PATH or AW_ROOT setup is needed.\n`);
    const wrapper=process.platform==='win32'?
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replaceAll('%','%%')}" "${launcher.replaceAll('%','%%')}" %*\r\nexit /b %errorlevel%\r\n`:
      `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(launcher)} "$@"\n`;
    // Validate every input and destination before replacing generated files.
    for(const file of [hostFile,cli,skillDir])fs.mkdirSync(path.dirname(file),{recursive:true});
    if(legacy)fs.unlinkSync(skillDir);
    fs.mkdirSync(skillDir,{recursive:true});
    atomicJson(hostFile,config);
    fs.copyFileSync(path.join(root,'skills','agent-workflow','aw.mjs'),launcher);
    atomicJson(manifestFile,manifest);
    fs.writeFileSync(path.join(skillDir,'SKILL.md'),skill);
    fs.writeFileSync(cli,wrapper,{mode:0o700});
    return {version:manifest.version,host_config:hostFile,cli,skill:skillDir,runtime:h.upstream_dir,command:invocation,updated:update};
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{apply:{type:'boolean'},update:{type:'boolean'},'host-config':{type:'string'},'bin-dir':{type:'string'},'skill-dir':{type:'string'}}});
    requireValue(v.apply&&p.length<=1,'usage','node scripts/install-local.mjs --apply [HOST_SOURCE] [--update] [--host-config FILE] [--bin-dir DIR] [--skill-dir DIR]');
    console.log(JSON.stringify(await installLocal({source:p[0],update:v.update,hostFile:v['host-config'],binDir:v['bin-dir'],skillDir:v['skill-dir']}),null,2));
  }catch(e){console.error(JSON.stringify({error:e.code??'install_error',message:e.message}));process.exitCode=1;}
}
