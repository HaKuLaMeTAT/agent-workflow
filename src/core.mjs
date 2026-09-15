import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import platform from './platform.cjs';

export class AwError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function fail(code, message) { throw new AwError(code, message); }
export function requireValue(ok, code, message) { if (!ok) fail(code, message); }
export function object(v, where) {
  requireValue(v && typeof v === 'object' && !Array.isArray(v), 'invalid_config', `${where} must be an object`);
}
export function fields(v, allowed, where) {
  object(v, where);
  for (const key of Object.keys(v)) requireValue(allowed.includes(key), 'invalid_config', `Unknown field ${where}.${key}`);
}
export function text(v, where, max = 64000) {
  requireValue(typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0'), 'invalid_input', `${where} must be a nonempty string (max ${max})`);
  return v;
}
export function id(v, where) {
  text(v, where, 100);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v), 'invalid_input', `Invalid ${where}`);
  return v;
}
export function integer(v, min, max, where) {
  requireValue(Number.isSafeInteger(v) && v >= min && v <= max, 'invalid_input', `${where} must be ${min}..${max}`);
  return v;
}
export function strings(v, where) {
  requireValue(Array.isArray(v), 'invalid_config', `${where} must be an array`);
  v.forEach(x => text(x, where));
  requireValue(new Set(v).size === v.length, 'invalid_config', `Duplicate entry in ${where}`);
  return v;
}
export function readJson(file, max = 1024 * 1024) {
  try {
    requireValue(fs.statSync(file).size <= max, 'input_too_large', `File exceeds ${max} bytes: ${file}`);
    const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), parsed = JSON.parse(source);
    // JSON.parse accepts duplicate keys. Reject ambiguous configuration and request documents.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [], stack = [];
    for (let i=0;i<tokens.length;i++) {
      const token=tokens[i];
      if(token==='{' || token==='[') stack.push(token==='{'?new Set():null);
      else if(token==='}' || token===']') stack.pop();
      else if(token.startsWith('"') && tokens[i+1]===':') {
        const keys=stack.at(-1), key=JSON.parse(token);
        requireValue(!keys.has(key),'duplicate_key',`Duplicate JSON key: ${key}`);keys.add(key);
      }
    }
    return parsed;
  } catch (e) {
    if (e instanceof AwError) throw e;
    fail('invalid_json', `Cannot read JSON ${file}: ${e.code ?? 'invalid syntax'}`);
  }
}
export function readText(file, max = 64000) {
  requireValue(fs.statSync(file).size <= max, 'input_too_large', `Text file too large: ${file}`);
  return fs.readFileSync(file, 'utf8');
}
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export function hash(v) { return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
export function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function within(root, file) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
export function real(file) { try { return fs.realpathSync(file); } catch { fail('missing_path', `Path does not exist: ${file}`); } }
export const processIdentity=platform.processIdentity;
export function sameProcess(identity) { return identity && JSON.stringify(processIdentity(identity.pid)) === JSON.stringify(identity); }
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
