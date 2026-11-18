const path = require('node:path');
const {execFileSync} = require('node:child_process');
const scenario = path.join(__dirname, 'browser/paui095-intake-first-reply.cjs');
for (const width of [1440,390]) {
  execFileSync(process.execPath,[scenario,'--paui098='+width],{stdio:'inherit',timeout:120000});
}
