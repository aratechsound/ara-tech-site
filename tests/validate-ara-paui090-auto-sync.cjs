const {execFileSync}=require('node:child_process'),path=require('node:path');
for(const test of ['paui090-state.mjs','paui090-read.cjs','browser/paui090-auto-sync.cjs'])execFileSync(process.execPath,[path.join(__dirname,test)],{stdio:'inherit',timeout:120000});
console.log('PAUI090 scoped automatic sync PASS; first/next reply, duplicate replay, safety boundaries, desktop/mobile; no live Gmail writes');
