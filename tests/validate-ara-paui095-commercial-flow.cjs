const { execFileSync } = require('node:child_process');
const path = require('node:path');

execFileSync(process.execPath, [path.join(__dirname, 'validate-pam-025-direct-confirmation.cjs')], {
  stdio: 'inherit',
  timeout: 120000
});
