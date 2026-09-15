import fs from 'node:fs';
import path from 'node:path';
import {fields,text,strings,id,integer,requireValue,real,readJson,readText,hash,within,object} from './core.mjs';
import {executable} from './adapters/common.mjs';
import {checkRuntime} from './runtime.mjs';
import {userPaths} from './paths.mjs';

export const TOOL_ROOT=path.resolve(import.meta.dirname,'..');
const DEFAULT_LIMITS={max_active_workers:2,default_timeout_seconds:1200,summary_max_chars:4000,result_page_max_chars:8000};
const ADAPTERS=['claude','codex','opencode','dsh','acp'];
export function loadHost(file) {
  const hostFile=real(file||process.env.AW_HOST_CONFIG||userPaths().host);
  return parseHost(hostFile,readJson(hostFile));
}
// In-memory previews use the same validation and path resolution as normal CLI reads.
export function parseHost(hostFile,h) {
  const base=path.dirname(hostFile);
  fields(h,['schema_version','host_id','catalog','providers','bindings','limits','state_dir','upstream_dir'],'host');
  requireValue(h.schema_version===1,'invalid_config','Expected host schema_version 1');id(h.host_id,'host_id');
  const catalogFile=real(path.resolve(base,text(h.catalog,'catalog'))),c=readJson(catalogFile);
  fields(c,['schema_version','roles'],'catalog');requireValue(c.schema_version===1,'invalid_config','Expected catalog schema_version 1');object(c.roles,'roles');
  const roles={};
  for(const [key,r] of Object.entries(c.roles)) {
    id(key,'role ID');fields(r,['label','description','instructions','execution','access','can_delegate','result_contract'],`role.${key}`);
    for(const key of ['label','description','instructions','result_contract'])text(r[key],key);
    requireValue(['host','worker'].includes(r.execution),'invalid_config','execution must be host or worker');
    requireValue(['read-only','workspace-write'].includes(r.access),'invalid_config','Invalid access');
    requireValue(typeof r.can_delegate==='boolean','invalid_config','can_delegate must be boolean');
    roles[key]={...r,instructions:real(path.resolve(path.dirname(catalogFile),r.instructions))};
  }
  object(h.providers,'providers');object(h.bindings,'bindings');const providers={};
  for(const [key,p] of Object.entries(h.providers)) {
    id(key,'provider ID');fields(p,['adapter','executable','args','auth','models','inherit_env','catalog_filter'],`provider.${key}`);
    requireValue(ADAPTERS.includes(p.adapter),'unsupported_adapter',`Unknown adapter ${p.adapter}`);
    const command=text(p.executable??(p.adapter==='acp'?'':p.adapter),'executable');
    requireValue(path.isAbsolute(command)||!/[\\/]/.test(command),'invalid_config','Use an absolute executable or a PATH command');
    requireValue(p.auth==='cli-managed','invalid_config','Only cli-managed authentication is supported');
    const args=p.args??(p.adapter==='dsh'?['--profile','acp']:[]);
    requireValue(Array.isArray(args)&&args.length<=20,'invalid_config','args must contain at most 20 entries');args.forEach(x=>text(x,'arg',4000));
    // Native adapters own their permission flags. ACP accepts only trusted launch prefixes.
    requireValue(['dsh','acp'].includes(p.adapter)||args.length===0,'unsupported_arguments','Native adapters do not accept permission/config overrides in args');
    if(p.models!==undefined){object(p.models,'models');for(const [model,efforts] of Object.entries(p.models)){text(model,'model');strings(efforts,'model efforts');}}
    const inherited=strings(p.inherit_env??[],'inherit_env');
    requireValue(inherited.every(k=>['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'].includes(k)),'invalid_config','Only proxy/certificate forwarding is supported');
    if(p.catalog_filter!==undefined)text(p.catalog_filter,'catalog_filter',100);
    providers[key]={...p,executable:command,args,inherit_env:inherited};
  }
  for(const [key,b] of Object.entries(h.bindings)) {
    requireValue(roles[key],'invalid_config',`Unknown role ${key}`);
    fields(b,['provider','model','effort','enabled','execution','access','permissions'],`binding.${key}`);
    requireValue(typeof b.enabled==='boolean','invalid_config','enabled must be boolean');
    if(b.execution!==undefined)requireValue(['host','worker'].includes(b.execution),'invalid_config','Invalid execution');
    if(b.access!==undefined)requireValue(b.access===roles[key].access||b.access==='read-only','permission_escalation','Binding cannot widen role access');
    requireValue(['restricted','full-access'].includes(b.permissions??'restricted'),'invalid_config','permissions must be restricted or full-access');
    const access=b.access??((b.execution??roles[key].execution)==='worker'&&roles[key].execution==='host'?'read-only':roles[key].access);
    if(b.permissions==='full-access')requireValue(roles[key].result_contract==='implementation'&&access==='workspace-write','permission_escalation','Full access requires an implementation role with workspace-write access');
    if(!b.enabled)continue;
    requireValue(providers[b.provider],'invalid_config',`Unknown provider ${b.provider}`);validateModel(providers[b.provider],b.model,b.effort??null);
  }
  fields(h.limits??{},Object.keys(DEFAULT_LIMITS),'limits');const limits={...DEFAULT_LIMITS,...h.limits};
  integer(limits.max_active_workers,1,8,'max_active_workers');integer(limits.default_timeout_seconds,1,7200,'default_timeout_seconds');
  integer(limits.summary_max_chars,100,8000,'summary_max_chars');integer(limits.result_page_max_chars,100,32000,'result_page_max_chars');
  return {hostFile,host_id:h.host_id,roles,providers,bindings:h.bindings,limits,
    state_dir:path.resolve(base,h.state_dir??path.join(userPaths().state,h.host_id)),
    upstream_dir:path.resolve(base,h.upstream_dir??path.join(TOOL_ROOT,'.runtime/node_modules/ai-cli-mcp'))};
}
function validateModel(provider,model,effort) {
  text(model,'model');if(effort!==null)text(effort,'effort');
  if(provider.models!==undefined) {
    requireValue(Object.hasOwn(provider.models,model),'unsupported_model',`Model not in host allowlist: ${model}`);
    requireValue(effort===null||provider.models[model].includes(effort),'unsupported_effort',`Unsupported configured effort for ${model}`);
  }
}
export function projectPolicy(h,cwd) {
  const work=real(cwd);requireValue(fs.statSync(work).isDirectory(),'invalid_input','cwd must be a directory');
  const ancestors=[];let current=work;
  for(let depth=0;depth<100;depth++) {
    ancestors.push(current);
    if(fs.existsSync(path.join(current,'.git'))||path.dirname(current)===current)break;
    current=path.dirname(current);
  }
  const found=ancestors.reverse().filter(dir=>fs.existsSync(path.join(dir,'agent-workflow.json')));
  let allowed=Object.keys(h.roles);const instructions=[],workflows={},files=[];
  for(const dir of found) {
    const file=path.join(dir,'agent-workflow.json'),p=readJson(file);
    fields(p,['schema_version','allowed_roles','instructions','workflows'],'project');requireValue(p.schema_version===1,'invalid_config','Project schema_version must be 1');
    strings(p.allowed_roles,'allowed_roles');strings(p.instructions??[],'instructions');
    for(const role of p.allowed_roles)requireValue(h.roles[role],'invalid_config',`Unknown project role ${role}`);
    allowed=allowed.filter(role=>p.allowed_roles.includes(role));
    object(p.workflows??{},'workflows');for(const [name,role] of Object.entries(p.workflows??{})) {
      id(name,'workflow');requireValue(allowed.includes(role),'role_not_allowed',`Workflow ${name} cannot widen ancestor role policy`);
      workflows[name]=role;
    }
    for(const name of p.instructions??[]) {
      const resolved=real(path.resolve(dir,name));requireValue(within(dir,resolved),'invalid_config','Project instructions must be inside their policy directory');
      if(!instructions.includes(resolved))instructions.push(resolved);
    }
    files.push(file);
  }
  return {cwd:work,root:found[0]??ancestors[0],allowed_roles:allowed,instructions,workflows,files};
}
export function resolveRole(h,roleId,cwd,overrides={}) {
  const project=projectPolicy(h,cwd);
  if(overrides.workflow) {
    const mapped=project.workflows[overrides.workflow];requireValue(mapped,'unknown_workflow',`No project mapping for ${overrides.workflow}`);
    requireValue(!roleId||roleId===mapped,'workflow_conflict','Explicit role conflicts with workflow mapping');roleId=mapped;
  }
  const defaults=h.roles[roleId],binding=h.bindings[roleId];
  requireValue(defaults&&binding?.enabled,'role_unavailable',`Role unavailable on ${h.host_id}: ${roleId}`);
  requireValue(project.allowed_roles.includes(roleId),'role_not_allowed',`Role not allowed by ancestor project policy: ${roleId}`);
  const execution=binding.execution??defaults.execution;
  const role={...defaults,execution,access:binding.access??(execution==='worker'&&defaults.execution==='host'?'read-only':defaults.access),permissions:binding.permissions??'restricted',can_delegate:execution==='worker'?false:defaults.can_delegate};
  const provider=h.providers[binding.provider],model=overrides.model??binding.model,effort=Object.hasOwn(overrides,'effort')?overrides.effort:binding.effort??null;
  validateModel(provider,model,effort);
  const binary=executable(provider.executable),runtime=checkRuntime(h.upstream_dir);
  const snapshot={host_id:h.host_id,role_id:roleId,provider_id:binding.provider,role:{...role,instructions:readText(role.instructions)},
    provider:{...provider,executable:binary??provider.executable},model,effort,cwd:project.cwd,project_root:project.root,workflow:overrides.workflow??null,
    project_policy_files:project.files,project_instructions:project.instructions.map(file=>({path:file,text:readText(file)})),limits:h.limits};
  return {...snapshot,config_hash:hash(snapshot),runnable:false,runtime,
    unavailable_reason:execution==='host'?'host_role_use_current_agent':!binary?'missing_executable':!runtime.available?'upstream_not_installed_or_patched':'capability_probe_required',
    guarantee:'Not probed; configuration is not proof of executable capability'};
}
export function publicRole(r,{instructions=false}={}) {
  return {role:r.role_id,label:r.role.label,execution:r.role.execution,access:r.role.access,permissions:r.role.permissions,provider:r.provider_id,adapter:r.provider.adapter,model:r.model,effort:r.effort,
    runnable:r.runnable,reason:r.unavailable_reason,guarantee:r.guarantee,config_hash:r.config_hash,cwd:r.cwd,project_root:r.project_root,workflow:r.workflow,
    discovery:r.discovery??null,...(instructions?{instructions:r.role.instructions,project_instructions:r.project_instructions}: {})};
}
