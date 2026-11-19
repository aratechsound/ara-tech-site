const path = require('node:path');
const { execFileSync } = require('node:child_process');

execFileSync(process.execPath, [
    path.join(__dirname, 'validate-ara-paui095-intake-commercial.cjs'), '--paui107'
], { stdio: 'inherit', timeout: 120_000 });

execFileSync(process.execPath, [
    path.join(__dirname, 'browser/pa-est-010r3-display-guard.cjs')
], { stdio: 'inherit', timeout: 120_000 });
