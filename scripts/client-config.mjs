import TOML from '@iarna/toml';

export class ConfigError extends Error {}
export const REMOVE = Symbol('remove');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const prefix = (a,b) => a.length <= b.length && a.every((x,i) => x === b[i]);
export function at(object, keys) { return keys.reduce((o,k) => o?.[k],object); }
export function parseConfig(text) {
  try { return TOML.parse(text.replace(/^\uFEFF/,'')); }
  catch { throw new ConfigError('Codex configuration is not valid TOML; no files were changed.'); }
}
function keyPath(text) {
  try {
    let value=TOML.parse(text+' = 0'), keys=[];
    while (value && typeof value === 'object' && !Array.isArray(value)) {
      const names=Object.keys(value);
      if(names.length!==1) throw new Error();
      keys.push(names[0]); value=value[names[0]];
    }
    if(value!==0) throw new Error();
    return keys;
  } catch { throw new ConfigError('This TOML key layout needs a manual merge; no files were changed.'); }
}
function quoteKey(value) { return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value); }
function scalar(value) {
  if(typeof value==='string') return JSON.stringify(value);
  if(typeof value==='boolean') return String(value);
  if(typeof value==='number' && Number.isFinite(value)) return String(value);
  if(value && typeof value==='object') return TOML.stringify.value(value);
  throw new ConfigError('Unsupported configuration value; no files were changed.');
}

function assignmentSuffix(raw) {
  let mode=null,escaped=false,square=0,curly=0;
  for(let i=0;i<raw.length;i++) {
    const c=raw[i];
    if(mode) {
      if(mode[0]==='"'&&escaped){escaped=false;continue;}
      if(mode[0]==='"'&&c==='\\'){escaped=true;continue;}
      if(mode.length===3&&raw.startsWith(mode,i)){let n=3;while(raw[i+n]===mode[0])n++;i+=n-1;mode=null;continue;}
      if(mode.length===1&&c===mode)mode=null;
    } else {
      if(c==='"'||c==="'"){mode=raw.startsWith(c.repeat(3),i)?c.repeat(3):c;i+=mode.length-1;}
      else if(c==='[')square++;else if(c===']')square--;
      else if(c==='{')curly++;else if(c==='}')curly--;
      else if(c==='#'&&square===0&&curly===0)return ' '+raw.slice(i).trimEnd();
    }
  }
  return '';
}

function inlineChanges(parsed,spans,changes,removePrefixes) {
  const groups=new Map(),direct=[];
  for(const change of [...changes,...removePrefixes.map(path=>({path,value:REMOVE}))]) {
    const ancestor=spans.find(s=>s.kind==='assignment'&&s.path.length<change.path.length&&prefix(s.path,change.path));
    if(!ancestor){if(changes.includes(change))direct.push(change);continue;}
    if(ancestor.arrayTable)throw new ConfigError('Ambiguous inline TOML target; no files were changed.');
    const id=JSON.stringify(ancestor.path);
    if(!groups.has(id)) {
      const original=at(parsed,ancestor.path);
      if(!original||typeof original!=='object'||Array.isArray(original))throw new ConfigError('Unsupported inline TOML target; no files were changed.');
      groups.set(id,{path:ancestor.path,value:TOML.parse('value = '+TOML.stringify.value(original)).value});
    }
    const group=groups.get(id),relative=change.path.slice(group.path.length);let object=group.value;
    for(const key of relative.slice(0,-1)) {
      if(!Object.hasOwn(object,key)) {
        if(change.value===REMOVE){object=null;break;}
        Object.defineProperty(object,key,{value:{},enumerable:true,writable:true,configurable:true});
      }
      object=object[key];
      if(!object||typeof object!=='object'||Array.isArray(object))throw new ConfigError('Unsupported inline TOML target; no files were changed.');
    }
    if(object) {
      if(change.value===REMOVE)delete object[relative.at(-1)];
      else Object.defineProperty(object,relative.at(-1),{value:change.value,enumerable:true,writable:true,configurable:true});
    }
  }
  return [...direct,...groups.values()];
}

// Scan complete TOML statements, including multiline strings, arrays and inline
// tables. Parse before and after editing; never reinterpret comments as config.
function statements(text) {
  const spans=[]; let start=0, mode=null, escaped=false, square=0, curly=0, comment=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(comment) { if(ch!=='\n') continue; comment=false; }
    else if(mode) {
      if(mode[0]==='"' && escaped) { escaped=false; continue; }
      if(mode[0]==='"' && ch==='\\') { escaped=true; continue; }
      if(mode.length===3 && text.startsWith(mode,i)) {
        let run=3; while(text[i+run]===mode[0]) run++;
        i+=run-1; mode=null; continue;
      }
      if(mode.length===1 && ch===mode) mode=null;
      continue;
    } else {
      if(ch==='#') {comment=true;continue;}
      if(ch==='"'||ch==="'") {mode=text.startsWith(ch.repeat(3),i)?ch.repeat(3):ch; i+=mode.length-1;continue;}
      if(ch==='[') square++; if(ch===']') square--;
      if(ch==='{') curly++; if(ch==='}') curly--;
    }
    if(ch==='\n' && square===0 && curly===0 && !mode) {spans.push({start,end:i+1});start=i+1;}
  }
  if(start<text.length) spans.push({start,end:text.length});
  let table=[], arrayTable=false;
  for(const span of spans) {
    const raw=text.slice(span.start,span.end), trimmed=raw.trim();
    if(!trimmed || trimmed.startsWith('#')) {span.kind='comment';continue;}
    if(trimmed.startsWith('[')) {
      const isArray=trimmed.startsWith('[['), close=isArray?']]':']';
      let quote=null, escape=false, end=-1;
      for(let i=isArray?2:1;i<trimmed.length;i++) {
        const c=trimmed[i];
        if(quote) {if(quote==='"'&&escape){escape=false;continue;}if(quote==='"'&&c==='\\'){escape=true;continue;}if(c===quote)quote=null;}
        else if(c==='"'||c==="'") quote=c;
        else if(trimmed.startsWith(close,i)){end=i;break;}
      }
      if(end<0) throw new ConfigError('Unsupported TOML table; no files were changed.');
      table=keyPath(trimmed.slice(isArray?2:1,end));arrayTable=isArray;
      Object.assign(span,{kind:'table',path:table,arrayTable});
    } else {
      let quote=null, escape=false, equal=-1;
      for(let i=0;i<raw.length;i++) {
        const c=raw[i];
        if(quote){if(quote==='"'&&escape){escape=false;continue;}if(quote==='"'&&c==='\\'){escape=true;continue;}if(c===quote)quote=null;}
        else if(c==='"'||c==="'")quote=c;
        else if(c==='='){equal=i;break;}
      }
      if(equal<0)throw new ConfigError('Unsupported TOML statement; no files were changed.');
      Object.assign(span,{kind:'assignment',path:[...table,...keyPath(raw.slice(0,equal).trim())],table,arrayTable,keyPrefix:raw.slice(0,equal+1)});
    }
  }
  return spans;
}

// Replace only explicitly owned keys. Unrelated comments, credentials, tables
// and multiline values remain byte-for-byte intact.
export function patchConfig(original, changes, removePrefixes=[]) {
  const text=original.replace(/^\uFEFF/,''), parsed=parseConfig(text), spans=statements(text), edits=[], pending=[];
  for(const change of inlineChanges(parsed,spans,changes,removePrefixes)) {
    const found=spans.filter(s=>s.kind==='assignment'&&same(s.path,change.path));
    if(found.length>1 || found.some(s=>s.arrayTable)) throw new ConfigError('Ambiguous TOML target; no files were changed.');
    if(found.length) {
      const s=found[0];
      if(change.value===REMOVE) edits.push({start:s.start,end:s.end,value:''});
      else if(!same(at(parsed,change.path),change.value)) {
        const ending=text.slice(s.start,s.end).endsWith('\r\n')?'\r\n':'\n';
        edits.push({start:s.start,end:s.end,value:s.keyPrefix+' '+scalar(change.value)+assignmentSuffix(text.slice(s.start,s.end))+ending});
      }
    } else if(change.value!==REMOVE) {
      if(spans.some(s=>s.kind==='assignment'&&prefix(s.path,change.path))) throw new ConfigError('An inline TOML parent needs a manual merge; no files were changed.');
      pending.push(change);
    }
  }
  for(const span of spans) if(span.path && removePrefixes.some(p=>prefix(p,span.path))) {
    if(!edits.some(e=>e.start===span.start)) edits.push({start:span.start,end:span.end,value:''});
  }
  const grouped=new Map();
  for(const c of pending) {const parent=c.path.slice(0,-1),id=JSON.stringify(parent);if(!grouped.has(id))grouped.set(id,{parent,values:[]});grouped.get(id).values.push(c);}
  const inserts=new Map();
  for(const {parent,values} of grouped.values()) {
    const headers=spans.filter(s=>s.kind==='table'&&same(s.path,parent));
    if(headers.length>1||headers.some(s=>s.arrayTable))throw new ConfigError('Ambiguous TOML target table; no files were changed.');
    let position,heading='';
    if(parent.length===0) position=spans.find(s=>s.kind==='table')?.start??text.length;
    else if(headers.length) position=spans.find(s=>s.kind==='table'&&s.start>headers[0].start)?.start??text.length;
    else {position=text.length;heading='\n['+parent.map(quoteKey).join('.')+']\n';}
    const body=heading+values.map(c=>quoteKey(c.path.at(-1))+' = '+scalar(c.value)+'\n').join('');
    if(!inserts.has(position))inserts.set(position,{inPlace:'',tables:''});
    const insert=inserts.get(position);
    insert[heading?'tables':'inPlace']+=body;
  }
  for(const [position,{inPlace,tables}] of inserts) edits.push({start:position,end:position,value:(position>0&&text[position-1]!=='\n'?'\n':'')+inPlace+tables});
  let result=text;
  edits.sort((a,b)=>b.start-a.start||b.end-a.end);
  for(const e of edits)result=result.slice(0,e.start)+e.value+result.slice(e.end);
  const final=parseConfig(result);
  for(const c of changes)if(c.value!==REMOVE&&!same(at(final,c.path),c.value))throw new ConfigError('Configuration verification failed; no files were changed.');
  for(const p of removePrefixes) if(at(final,p)!==undefined)throw new ConfigError('Legacy MCP transport needs a manual merge; no files were changed.');
  return result;
}

export function effectiveConfig(config) {
  const profile=typeof config.profile==='string'?config.profile:null;
  const scoped=profile&&config.profiles?.[profile]&&typeof config.profiles[profile]==='object'?config.profiles[profile]:{};
  return {profile,provider:scoped.model_provider??config.model_provider??'openai',catalog:scoped.model_catalog_json??config.model_catalog_json};
}
