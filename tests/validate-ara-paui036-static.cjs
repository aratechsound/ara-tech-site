'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Use the parser already bundled with the pinned Playwright dev dependency.
const {babelParse,traverse}=require(path.join(path.dirname(require.resolve('playwright/package.json')),'lib/transform/babelBundle.js'));
const root=path.resolve(__dirname,'..'),dir=path.join(root,'pa-ui/js');
const globals=new Set(['document','window','location','navigator','fetch','Option','FormData','AbortController','URL','Blob','Image','HTMLElement','HTMLDialogElement','ResizeObserver','IntersectionObserver','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','setInterval','clearInterval','performance','console','atob','crypto','matchMedia','getComputedStyle','devicePixelRatio']);
for(const name of ['queueMicrotask','NodeFilter','Event','CustomEvent','MutationObserver'])globals.add(name);
const external=new Map([['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',new Set(['createClient'])]]);
function analyze(sources){
 const parsed=new Map(),failures=[];
 for(const [file,source] of sources){
  const ast=babelParse(source,file),exports=new Set(),imports=[];
  traverse(ast,{ReferencedIdentifier(p){const name=p.node.name;if(!p.scope.hasBinding(name)&&!globals.has(name))failures.push(file+':'+p.node.loc.start.line+' undefined '+name);},
   ImportDeclaration(p){imports.push(p.node);},
   ExportNamedDeclaration(p){const n=p.node;if(n.declaration?.id)exports.add(n.declaration.id.name);for(const d of n.declaration?.declarations||[])if(d.id.type==='Identifier')exports.add(d.id.name);for(const s of n.specifiers)exports.add(s.exported.name);},
   ExportDefaultDeclaration(){exports.add('default');}});
  parsed.set(file,{exports,imports});
 }
 for(const [file,m] of parsed)for(const i of m.imports){
  if(!i.source.value.startsWith('.')&&!external.has(i.source.value)){failures.push(file+' unpublished dependency '+i.source.value);continue;}
  const target=path.resolve(path.dirname(file),i.source.value),dep=external.has(i.source.value)?{exports:external.get(i.source.value)}:parsed.get(target);
  if(!dep){failures.push(file+' missing module '+i.source.value);continue;}
  for(const s of i.specifiers)if(s.type!=='ImportNamespaceSpecifier'){
   const name=s.type==='ImportDefaultSpecifier'?'default':s.imported.name;
   if(!dep.exports.has(name))failures.push(file+' missing export '+name+' in '+i.source.value);
  }
 }
 return failures;
}
const sources=new Map(fs.readdirSync(dir).filter(n=>n.endsWith('.mjs')).map(n=>{const f=path.join(dir,n);return [f,fs.readFileSync(f,'utf8')];}));
const config=path.join(root,'js/supabase-config.js');sources.set(config,fs.readFileSync(config,'utf8'));
// CASE DESK shares the existing commercial display authority; analyze its exports too.
const commercialDisplay=path.join(root,'js/pa-confirmation-display.mjs');sources.set(commercialDisplay,fs.readFileSync(commercialDisplay,'utf8'));
assert.deepEqual(analyze(sources),[],'All published desk surfaces and their module dependencies must resolve');
const desk=path.join(dir,'desk.mjs'),model=path.join(dir,'model.mjs');
const badReference=new Map(sources);badReference.set(desk,sources.get(desk).replace('body:r=>deliveryUnknown(r)','body:r=>missingDeliveryHelper(r)'));
assert(analyze(badReference).some(e=>e.includes('undefined missingDeliveryHelper')));
const badExport=new Map(sources);badExport.set(model,sources.get(model).replace('export function deliveryUnknown','function deliveryUnknown'));
assert(analyze(badExport).some(e=>e.includes('missing export deliveryUnknown')));
const badModule=new Map(sources);badModule.set(desk,sources.get(desk).replace("from './model.mjs'","from './unpublished-model.mjs'"));
assert(analyze(badModule).some(e=>e.includes('missing module ./unpublished-model.mjs')));
console.log(JSON.stringify({status:'PASS',modules:sources.size,undefined_identifiers:0,missing_imports_exports:0,unpublished_dependencies:0,negative_controls:3,surfaces:['overview','conversation','estimate','documents','invoice','history','manual-thread-link']}));
