const {execFileSync}=require('node:child_process');
const path=require('node:path');
for(const test of ['paui089-state.mjs','paui089-context.cjs','browser/paui089-composer.cjs','browser/pa-inbound-direct-reply.cjs','validate-pam-024-minimal.cjs','validate-pam-008-inbound-direct-reply.cjs','validate-pam-005-gmail-reply-attachments.cjs','validate-pam-010-mailbox-profile.cjs'])execFileSync(process.execPath,[path.join(__dirname,test)],{stdio:'inherit',timeout:120000});
console.log('PAUI089 new CASE DESK and legacy reply regression PASS; all transports isolated; real send 0');
