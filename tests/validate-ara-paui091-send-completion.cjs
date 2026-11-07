const {execFileSync}=require('node:child_process'),path=require('node:path');
for(const test of ['paui091-state.mjs','browser/paui091-send-completion.cjs'])execFileSync(process.execPath,[path.join(__dirname,test)],{stdio:'inherit',timeout:120000});
console.log('PAUI091 verified send completion, read-only recovery, navigation and desktop/mobile PASS; real Gmail sends0');
