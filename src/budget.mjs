import {fields,integer,requireValue} from './core.mjs';

export const DEFAULT_BUDGET={max_model_turns:24,max_tool_calls:48,max_output_tokens:32000,max_provider_calls:4,max_duration_seconds:1200,max_read_bytes:131072,max_total_read_bytes:262144};
export function budgetPolicy(value={},base=DEFAULT_BUDGET,{lowerOnly=false}={}) {
  fields(value,Object.keys(DEFAULT_BUDGET),'budget');
  const result={...base,...value};
  for(const [key,limit] of Object.entries(result)) {
    integer(limit,1,key.endsWith('bytes')?16*1024*1024:key==='max_output_tokens'?1000000:key==='max_duration_seconds'?7200:1000,`budget.${key}`);
    if(lowerOnly)requireValue(limit<=base[key],'budget_widened',`Task budget ${key} exceeds the configured limit`);
  }
  return result;
}
export function emptyCounters(){return {model_turns:0,tool_calls:0,output_tokens:0,provider_calls:0,duration_seconds:0,read_bytes:0};}
const mapping={model_turns:'max_model_turns',tool_calls:'max_tool_calls',output_tokens:'max_output_tokens',provider_calls:'max_provider_calls',duration_seconds:'max_duration_seconds',read_bytes:'max_total_read_bytes'};
export function sumCounters(values){const out=emptyCounters();for(const v of values)for(const k of Object.keys(out))out[k]+=v?.[k]??0;return out;}
export function remainingBudget(policy,used={}) {
  const out={...policy};for(const [key,max] of Object.entries(mapping))out[max]=Math.max(0,policy[max]-(used[key]??0));return out;
}
export function exhaustedBudget(policy,used={}) {return Object.entries(mapping).find(([key,max])=>(used[key]??0)>=policy[max])?.[1]??null;}
