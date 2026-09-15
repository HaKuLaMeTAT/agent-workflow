import {resolveRole,publicRole,projectPolicy} from './config.mjs';
import {fields,requireValue,integer} from './core.mjs';

// The host classifies the user's task. This deterministic policy does not call
// a classifier model, change bindings, submit work, or silently change providers.
export function routeTask(h,cwd,input) {
  fields(input,['kind','complexity','failed_attempts','delegations'],'routing input');
  const kind=input.kind,complexity=input.complexity??'standard';
  requireValue(['code','artifact','design','review','analysis','conversation'].includes(kind),'invalid_input','Unknown task kind');
  requireValue(['trivial','simple','standard','complex'].includes(complexity),'invalid_input','Unknown complexity');
  const failures=integer(input.failed_attempts??0,0,100,'failed_attempts'),delegations=integer(input.delegations??0,0,100,'delegations');
  const policy=h.routing,base={kind,complexity,automatic:policy.enabled,delegations_remaining:Math.max(0,policy.max_delegations-delegations)};
  if(!policy.enabled)return {...base,action:'host',reason:'automatic_routing_disabled'};
  if(kind==='conversation'||(['code','artifact'].includes(kind)&&complexity==='trivial'))return {...base,action:'host',reason:'direct_response_or_trivial_task'};
  if(delegations>=policy.max_delegations)return {...base,action:'host',reason:'delegation_budget_reached',next_action:'Inspect existing evidence; do not start another automatic worker for this work package'};
  let key=kind==='code'?`code_${complexity}`:kind,escalated=false;
  if(failures>=policy.escalate_after) {
    if(kind!=='code'||complexity==='complex')return {...base,action:'host',reason:'escalation_requires_host_decision'};
    key=complexity==='simple'?'code_standard':'code_complex';escalated=true;
    const next=policy.roles[key],binding=h.bindings[next];
    // Basic and main development normally share the current Codex host. Moving
    // between those labels does not provide an independent escalation.
    if(key==='code_standard'&&binding?.enabled&&(binding.execution??h.roles[next].execution)==='host')key='code_complex';
  }
  const role=policy.roles[key],project=projectPolicy(h,cwd);
  if(!project.allowed_roles.includes(role))return {...base,action:'blocked',role,reason:'role_not_allowed'};
  if(!h.bindings[role]?.enabled)return {...base,action:'blocked',role,reason:'role_unavailable'};
  const selected=resolveRole(h,role,cwd);
  const action=selected.role.execution==='host'?'host':'worker';
  return {...base,action,role,reason:escalated?'configured_escalation':'configured_route',escalated,
    selected:publicRole(selected),suggested_workspace:action==='worker'&&selected.role.access==='workspace-write'?(kind==='artifact'?'directory':kind==='code'?'git-worktree':null):null,
    next_action:action==='worker'?'Prepare/submit this role with bounded acceptance and the explicitly selected workspace mode':'Perform this role in the current host task'};
}
