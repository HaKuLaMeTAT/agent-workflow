import {requireValue, fields, strings, text} from './core.mjs';

export const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary','findings','evidence_refs','uncertainties','payload'],
  properties: {
    summary: {type:'string'},
    findings: {type:'array', items: {
      type:'object', additionalProperties:false,
      required:['severity','location','trigger','impact','evidence'],
      properties: {
        severity:{enum:['blocker','risk','note']},
        ...Object.fromEntries(['location','trigger','impact','evidence'].map(k=>[k,{type:'string'}]))
      }
    }},
    evidence_refs:{type:'array',items:{type:'string'}},
    uncertainties:{type:'array',items:{type:'string'}},
    payload:{type:'object'}
  }
};

export function resultSchema(contract) {
  const schema=structuredClone(RESULT_SCHEMA);
  const contracts={design:{strings:['recommendation'],arrays:['constraints','tradeoffs','acceptance','assumptions']},
    analysis:{strings:['as_of'],arrays:['key_premises','supporting_evidence','counter_evidence','disagreements','revisions']},
    implementation:{strings:['scope'],arrays:['changes','verification','limitations']}};
  const shape=contracts[contract];
  if(shape)schema.properties.payload={type:'object',additionalProperties:false,required:[...shape.strings,...shape.arrays],properties:{
    ...Object.fromEntries(shape.strings.map(k=>[k,{type:'string'}])),...Object.fromEntries(shape.arrays.map(k=>[k,{type:'array',items:{type:'string'}}]))}};
  if(contract==='review')schema.properties.payload={type:'object',additionalProperties:false,
    required:['verdict','acceptance_checks','unverified_checks','scope'],properties:{
      verdict:{enum:['pass','fail','incomplete']},
      acceptance_checks:{type:'array',items:{type:'string'}},
      unverified_checks:{type:'array',items:{type:'string'}},scope:{type:'string'}
    }};
  return schema;
}
// Providers generate one flat object. AW keeps the stable public payload envelope.
export function deliverySchema(contract) {
  const schema=resultSchema(contract),payload=schema.properties.payload;
  if(!payload.properties)return schema;
  delete schema.properties.payload;
  schema.required=schema.required.filter(k=>k!=='payload').concat(payload.required);
  Object.assign(schema.properties,payload.properties);
  return schema;
}
export function normalizeDelivery(value,contract) {
  let v=value;const repairs=[];
  for(let n=0;n<2&&v&&typeof v==='object'&&!Array.isArray(v);n++) {
    const keys=Object.keys(v);
    if(keys.length===1&&['parameter','parameters','result','payload'].includes(keys[0])&&typeof v[keys[0]]==='object') {
      repairs.push(`unwrap:${keys[0]}`);v=v[keys[0]];
    }else break;
  }
  if(v&&typeof v==='object'&&!Array.isArray(v)&&!Object.hasOwn(v,'payload')) {
    const root=RESULT_SCHEMA.required.filter(k=>k!=='payload'),payloadKeys=Object.keys(resultSchema(contract).properties.payload.properties??{});
    if(payloadKeys.length&&root.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>root.includes(k)||payloadKeys.includes(k))) {
      v={...Object.fromEntries(root.map(k=>[k,v[k]])),payload:Object.fromEntries(payloadKeys.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]))};
    }
  }
  validateResult(v,contract);
  return {data:v,delivery:{format:'flat-v1',local_repairs:repairs,aw_model_retries:0}};
}
export function validateResult(v, contract) {
  fields(v,['summary','findings','evidence_refs','uncertainties','payload'],'result');
  text(v.summary,'summary',1000000);
  requireValue(Array.isArray(v.findings),'invalid_result','findings must be array');
  for(const f of v.findings) {
    fields(f,['severity','location','trigger','impact','evidence'],'finding');
    requireValue(['blocker','risk','note'].includes(f.severity),'invalid_result','Invalid finding severity');
    for(const k of ['location','trigger','impact','evidence']) text(f[k],k,1000000);
  }
  strings(v.evidence_refs,'evidence_refs');strings(v.uncertainties,'uncertainties');
  requireValue(v.payload && typeof v.payload === 'object' && !Array.isArray(v.payload),'invalid_result','payload must be object');
  if(v.payload.unverified_checks!==undefined)strings(v.payload.unverified_checks,'unverified_checks');
  if(v.payload.verdict!==undefined)requireValue(['pass','fail','incomplete'].includes(v.payload.verdict),'invalid_result','Invalid verdict');
  if(contract==='review') {
    const p=v.payload;
    requireValue(['pass','fail','incomplete'].includes(p.verdict),'invalid_result','Review requires pass/fail/incomplete verdict');
    strings(p.acceptance_checks,'acceptance_checks');strings(p.unverified_checks,'unverified_checks');text(p.scope,'scope');
    requireValue(p.verdict!=='pass'||(p.unverified_checks.length===0 && p.acceptance_checks.length>0 && !v.findings.some(f=>f.severity==='blocker')),'invalid_result','A pass cannot contain unverified checks or blockers');
    requireValue(p.verdict!=='incomplete'||p.unverified_checks.length>0,'invalid_result','Incomplete review must name unverified checks');
  }
  if(contract==='implementation') {
    text(v.payload.scope,'scope');
    for(const key of ['changes','verification','limitations'])strings(v.payload[key],key);
  }
  if(['design','analysis'].includes(contract)) {
    const shape=resultSchema(contract).properties.payload;
    for(const [key,schema] of Object.entries(shape.properties))schema.type==='array'?strings(v.payload[key],key):text(v.payload[key],key);
  }
  return v;
}
export async function parseTranscript(file, contract) {
  // Compatibility helper; task execution dispatches through the selected adapter.
  const {claude}=await import('./adapters/claude.mjs');const result=await claude.observe(file);
  requireValue(!result.error,result.error,'Provider failed; inspect retained transcript');
  requireValue(result.final,'invalid_result','No final provider result event');
  Object.assign(result,normalizeDelivery(result.data,contract));return result;
}
export function pageResult(result, limits, cursor) {
  const doc=JSON.stringify(result.data,null,2), chars=Array.from(doc), summary=Array.from(result.data.summary);
  if(cursor === undefined) return {
    summary:summary.slice(0,limits.summary_max_chars).join(''),
    verdict:result.data.payload.verdict ?? null,
    unverified_checks:(result.data.payload.unverified_checks??[]).slice(0,5).map(s=>s.slice(0,300)),
    unverified_check_count:(result.data.payload.unverified_checks??[]).length,
    uncertainties:result.data.uncertainties.slice(0,5).map(s=>s.slice(0,300)),
    finding_counts:{blocker:result.data.findings.filter(f=>f.severity==='blocker').length,risk:result.data.findings.filter(f=>f.severity==='risk').length,note:result.data.findings.filter(f=>f.severity==='note').length},
    evidence_refs:result.data.evidence_refs.slice(0,5).map(s=>Array.from(s).slice(0,300).join('')),
    evidence_ref_count:result.data.evidence_refs.length,uncertainty_count:result.data.uncertainties.length,
    completeness:{summary_truncated:summary.length>limits.summary_max_chars,has_more:true,next_cursor:0,total_chars:chars.length},
    usage:result.usage,effective_model:result.model,effective_effort:result.effective_effort??null,
    effort_verification:result.effective_effort?'cli_acknowledged':'unverified; requested argv recorded',estimated_cost_usd:result.estimated_cost_usd
  };
  requireValue(Number.isSafeInteger(cursor) && cursor>=0 && cursor<=chars.length,'invalid_cursor','Invalid cursor');
  const end=Math.min(chars.length,cursor+limits.result_page_max_chars);
  return {text:chars.slice(cursor,end).join(''),completeness:{has_more:end<chars.length,next_cursor:end<chars.length?end:null,total_chars:chars.length}};
}
