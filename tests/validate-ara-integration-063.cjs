'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const mail=require('../api/_pa-mail.cjs'),service=require('../api/_pa-case-mail.cjs');
const pdf=Buffer.from('%PDF-1.4\nsynthetic only\n%%EOF');
const a={filename:'見積という名前.pdf',mime_type:'application/pdf',data:pdf.toString('base64url')};
const input={subject:'Fixture',body:'Synthetic',attachments:[a]};
const authority={subject:'Fixture',case_email:'customer@example.invalid',inquiry_id:'11111111-1111-4111-8111-111111111111',kind:'new',purpose:'general',to:'customer@example.invalid',cc:[],unverified_recipients:[],authority_hash:'fixture'};
const normal=service.binding(authority,input);assert(!Object.hasOwn(normal.b.attachments[0],'document_kind'),'filename must not classify');
for(const kind of ['estimate','invoice']){
 const classified=service.binding(authority,{...input,attachments:[{...a,document_kind:kind}]});
 assert.equal(classified.b.attachments[0].document_kind,kind);assert.equal(classified.b.attachments[0].sha256,crypto.createHash('sha256').update(pdf).digest('hex'));
 assert.notDeepEqual(classified.b,normal.b,'classification belongs to immutable operation identity');
}
assert.throws(()=>mail.normalizeReplyAttachments([{...a,document_kind:'invoice',data:Buffer.from('not pdf').toString('base64url')}]),/invalid_reply_attachment/);
assert.throws(()=>mail.normalizeReplyAttachments([{...a,document_kind:'other'}]),/invalid_reply_attachment/);
assert.equal(service.binding(authority,{...input,attachments:[]}).b.attachments.length,0);
const desk=fs.readFileSync(require.resolve('../pa-ui/js/desk.mjs'),'utf8');assert(desk.includes("button('メール作成','case-mail-compose'"));assert(!desk.includes('createReplyComposer('));
const trash=fs.readFileSync(require.resolve('../pa-ui/js/case-trash.mjs'),'utf8');assert(!/action:\s*['"](?:purge|restore)/u.test(trash));assert(trash.includes('s.attempted=true'));assert(trash.includes('saved.inquiry_id!==s.id'));assert(trash.includes('saved.inquiry_number!==s.number'));assert(trash.includes('saved.delete_reason!==reason.value'));
console.log(JSON.stringify({status:'PASS',classification_bound_per_file:true,normal_by_default:true,optional_attachments:true,one_shared_composer:true,trash_exact_identity_once:true,purge_path_absent:true,real_sends:0}));
