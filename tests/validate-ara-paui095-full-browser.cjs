const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scenario = path.join(__dirname, 'browser', 'paui095-intake-first-reply.cjs');
// The container's LC_ALL=C is for deterministic shell sorting. Chromium needs
// a UTF-8 filename locale to test the same download names as the desktop.
const env = process.platform === 'linux' ? { ...process.env, LC_ALL: 'C.UTF-8' } : process.env;
for (const args of [[], ['--no-separate-invoice']]) {
  execFileSync(process.execPath, [scenario, ...args], { env, stdio: 'inherit', timeout: 120000 });
}
console.log('PAUI-095 isolated browser intake-to-close PASS for both invoice routes');
