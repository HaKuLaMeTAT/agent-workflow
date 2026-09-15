'use strict';
const crossSpawn=require('cross-spawn');
const escape=require('cross-spawn/lib/util/escape.js');
const path=require('node:path');
// npm global shims also forward through %*, outside node_modules/.bin.
// They require the same second escaping pass as local npm shims.
module.exports=function spawnCli(command,args,options={}) {
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command)) {
    const line=[escape.command(path.normalize(command)),...args.map(arg=>escape.argument(arg,true))].join(' ');
    return crossSpawn(process.env.ComSpec||path.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),['/d','/s','/c',`"${line}"`],{...options,windowsVerbatimArguments:true,windowsHide:true});
  }
  return crossSpawn(command,args,{windowsHide:true,...options});
};
