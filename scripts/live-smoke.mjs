// Opt-in model acceptance. No inference is performed when this module is imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadHost} from '../src/config.mjs';
import {readJson,requireValue,atomicJson} from '../src/core.mjs';
import {submit,wait,readTask} from '../src/tasks.mjs';
export function verifySmoke(parsed,{evidenceFile,nonce,model,readMode='native'}) {
  requireValue(parsed.model===model,'unverified_model','CLI did not confirm the requested model');
  if(readMode==='evidence') {
    requireValue(Array.isArray(parsed.tools)&&parsed.tools.every(k=>k==='StructuredOutput'),'unverified_tools','Evidence mode exposed unexpected tools');
    requireValue(parsed.provided_evidence?.files.some(f=>f.path===evidenceFile),'evidence_not_read','Evidence was not included in the bounded bundle');
  }else {
    requireValue(Array.isArray(parsed.tools)&&['Read','Glob','Grep'].every(k=>parsed.tools.includes(k))&&parsed.tools.every(k=>['Read','Glob','Grep','StructuredOutput'].includes(k)),'unverified_tools','Unexpected CLI tool inventory');
    requireValue(parsed.reads?.some(file=>path.resolve(path.dirname(evidenceFile),file)===evidenceFile),'evidence_not_read','No successful read result for the evidence file');
  }
  requireValue(parsed.data.evidence_refs.some(ref=>ref.includes(nonce)),'evidence_not_read','The evidence-only nonce was not returned');
  requireValue(parsed.data.findings.some(f=>f.severity==='blocker'&&f.trigger.includes('DIVIDE_BY_ZERO')),'acceptance_failed','The required zero-divisor defect was not identified');
  requireValue(parsed.data.payload.verdict!=='pass','acceptance_failed','The known defective interface cannot pass review');
  requireValue(JSON.stringify(parsed.data).includes('STATIC_ONLY'),'acceptance_failed','The result must distinguish static analysis from runtime verification');
  return true;
}
async function main() {
  requireValue(process.argv[2]==='--run'&&['designer','reviewer'].includes(process.argv[3]),'usage','node scripts/live-smoke.mjs --run designer|reviewer [HOST_CONFIG]');
  const role=process.argv[3],h=loadHost(process.argv[4]),root=fs.mkdtempSync(path.join(os.tmpdir(),`aw-live-${role}-`));
  const nonce=randomUUID(),evidenceFile=path.join(root,'evidence.md');
  fs.writeFileSync(evidenceFile,`EVIDENCE_NONCE: ${nonce}\n接口实现：function divide(a, b) { return a / b; }\n调用合同：b 为 0 时必须返回显式错误。\n`);
  const raw={goal:'读取 evidence.md 并独立分析接口合同缺口。把文件内 EVIDENCE_NONCE 的值放入 evidence_refs；如发现除零缺陷，在 finding.trigger 标记 DIVIDE_BY_ZERO。结果标注 STATIC_ONLY：只做静态检查，未执行运行验证。给出最小设计或独立验收意见。',acceptance:['实际读取 evidence.md 并引用其独有标识。','识别零除数没有显式错误的阻塞缺陷。','区分静态分析和运行验证，不把缺陷判为通过。'],read_paths:['evidence.md'],source:'live-smoke',timeout_seconds:180};
  const launched=await submit(h,{role,cwd:root,raw,requestId:`smoke-${path.basename(root)}`});console.log(JSON.stringify({task_id:launched.task_id,evidence_directory:root,role}));
  let current=launched;const deadline=Date.now()+210000;
  do {current=await wait(h,launched.task_id,45);console.log(JSON.stringify(current));}while(current.wait_timed_out&&Date.now()<deadline);
  requireValue(current.state==='completed','smoke_failed',`Live task ended in ${current.state}; retain the task ID and recover explicitly`);
  const m=readTask(h,current.task_id),parsed=readJson(path.join(h.state_dir,'tasks',current.task_id,'result.json'));
  verifySmoke(parsed,{evidenceFile,nonce,model:m.snapshot.model,readMode:m.snapshot.read_mode});
  const record={task_id:current.task_id,role,model:parsed.model,tools:parsed.tools,evidence_read:true,contract_check:'passed',effort:m.snapshot.effort,effort_verification:'argv_only',usage:parsed.usage,evidence_directory:root,limitation:'Bounded known-defect acceptance; not a general quality or filesystem-isolation proof'};
  atomicJson(path.join(root,'acceptance.json'),record);console.log(JSON.stringify(record,null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(JSON.stringify({error:e.code??'smoke_error',message:e.message}));process.exitCode=1;});
