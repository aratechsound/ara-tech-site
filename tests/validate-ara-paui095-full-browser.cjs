const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scenario = path.join(__dirname, 'browser', 'paui095-intake-first-reply.cjs');
for (const args of [[], ['--no-separate-invoice']]) {
  execFileSync(process.execPath, [scenario, ...args], { stdio: 'inherit', timeout: 120000 });
}
console.log('PAUI-095 isolated browser intake-to-close PASS for both invoice routes');
