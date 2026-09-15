import {loadHost,parseHost} from './config.mjs';
import {readJson,readText,fields,text,requireValue,hash,atomicJson} from './core.mjs';
import {withFileLock} from './locking.mjs';

const EDITABLE=['provider','model','effort','enabled','execution'];
function effectiveBinding(h,id) {
  const b=h.bindings[id]??{},r=h.roles[id];
  return {provider:b.provider??'',model:b.model??'',effort:b.effort??null,enabled:b.enabled??false,execution:b.execution??r.execution};
}
export function configurationSnapshot(file) {
  const hostFile=loadHost(file).hostFile,raw=readJson(hostFile),host=parseHost(hostFile,raw);
  const roles=Object.entries(host.roles).map(([id,r])=>({id,label:r.label,description:r.description,instructions:readText(r.instructions),access:r.access,binding:effectiveBinding(host,id)}));
  const revision=hash({raw,roles});
  return {host,raw,revision,view:{host_id:host.host_id,host_config:hostFile,revision,roles,
    providers:Object.entries(host.providers).map(([id,p])=>({id,adapter:p.adapter,executable:p.executable,has_allowlist:p.models!==undefined,models:Object.entries(p.models??{}).map(([id,efforts])=>({id,efforts,allowed:true,verified:false,source:'configured'}))})),limits:host.limits}};
}

// One host file is the transaction boundary; both the CLI and UI use this writer.
export async function editBindings(file,{changes,revision,write=false}) {
  requireValue(!write||process.env.AW_WORKER!=='1','delegation_forbidden','Read-only workers cannot edit configuration');
  const hostFile=loadHost(file).hostFile;
  const apply=()=>{
    const current=configurationSnapshot(hostFile),next=structuredClone(current.raw);
    if(revision!==undefined)requireValue(revision===current.revision,'config_conflict','配置已被其他操作更新。请重新读取后再编辑，当前草稿尚未保存。');
    requireValue(Array.isArray(changes)&&changes.length>0&&changes.length<=Object.keys(current.host.roles).length,'invalid_input','Expected a nonempty list of role changes');
    const seen=new Set();
    for(const change of changes) {
      fields(change,['role','patch'],'change');text(change.role,'role');
      requireValue(Object.hasOwn(current.host.roles,change.role)&&!seen.has(change.role),'invalid_input','Unknown or duplicate role');seen.add(change.role);
      fields(change.patch,EDITABLE,'binding patch');requireValue(Object.keys(change.patch).length>0,'invalid_input','Empty binding patch');
      if(Object.hasOwn(change.patch,'provider'))requireValue(Object.hasOwn(current.host.providers,change.patch.provider),'invalid_config','请选择已配置的 CLI。');
      if(Object.hasOwn(change.patch,'model'))text(change.patch.model,'model');
      if(Object.hasOwn(change.patch,'effort')&&change.patch.effort!==null)text(change.patch.effort,'effort');
      next.bindings[change.role]={...next.bindings[change.role],...change.patch};
    }
    const validated=parseHost(hostFile,next),diff=[];
    for(const role of seen) {
      const before=effectiveBinding(current.host,role),after=effectiveBinding(validated,role),b=validated.bindings[role],defaults=validated.roles[role];
      const access=b.access??(after.execution==='worker'&&defaults.execution==='host'?'read-only':defaults.access);
      requireValue(!after.enabled||after.execution!=='worker'||access==='read-only'||(validated.providers[b.provider].adapter==='claude'&&defaults.result_contract==='implementation'),'permission_unsupported','当前可写执行模式需要 Claude adapter 和 implementation 结果合同。');
      for(const field of EDITABLE)if(before[field]!==after[field])diff.push({role,label:defaults.label,field,before:before[field],after:after[field]});
    }
    if(write) {
      // Also detect edits made outside our lock before replacing the file.
      requireValue(configurationSnapshot(hostFile).revision===current.revision,'config_conflict','配置在保存前发生变化，请重新读取。');
      atomicJson(hostFile,next);
    }
    return {written:write,host_config:hostFile,revision:current.revision,changes:diff,configuration:next,...(write?{snapshot:configurationSnapshot(hostFile).view}:{})};
  };
  return write?withFileLock(`${hostFile}.lock`,apply):apply();
}
