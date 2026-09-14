const fs=require('node:fs');
const path=require('node:path');
const {PDFDocument}=require('pdf-lib');
const {createReceipt,sha}=require('../api/_pa-contract-pdf.cjs');
const {issuanceTermsV4}=require('../api/_pa-contract-terms.cjs');

async function main(){
 const output=process.argv[2];if(!output)throw Error('output path required');
 const quoteDoc=await PDFDocument.create(),quotePage=quoteDoc.addPage([595.276,841.89]);
 quotePage.drawText('CONTROLLED VISUAL GATE ESTIMATE SOURCE',{x:40,y:780,size:14});
 const quote=Buffer.from(await quoteDoc.save()),terms=issuanceTermsV4('2026-10-18');
 const snapshot={
  snapshot_schema_version:'PA-FORMAL-V5-20260914-1',
  case:{event_name:'2026 龍姫湖まつり',event_date:'2026-10-18',event_time:'10:00〜15:00',venue:'温井ダム堤体横駐車場',service_scope:'PA・音響・電源対応'},
  customer:{organization:'安芸太田町 産業観光課 商工観光係',department:null,contact_name:'竹林 智也',display_name:'竹林 智也'},
  estimate:{revision_number:2,amount_minor:198550,currency:'JPY',original_filename:'見積書 2026.09.11 龍姫湖まつり（改訂）.pdf',mime_type:'application/pdf',sha256:sha(quote),sent_at:'2026-09-11T03:54:00Z'},
  terms,
  issuance:{issued_at:'2026-09-14T00:00:00Z',expires_at:'2026-09-21T00:00:00Z'},
  acceptance:{confirmer_name:'竹林 智也',confirmed_at:'2026-09-14T01:00:00Z',agreed:true}
 };
 const receipt=await createReceipt(snapshot,quote);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,receipt.bytes);
 fs.writeFileSync(output.replace(/\.pdf$/u,'.json'),JSON.stringify({receipt_sha256:receipt.sha256,source_estimate_sha256:sha(quote),cover_pages:receipt.cover_pages,quote_pages:receipt.quote_pages,source_estimate_bytes_changed:false},null,2));
 console.log(JSON.stringify({receipt_sha256:receipt.sha256,source_estimate_sha256:sha(quote),pages:receipt.cover_pages+receipt.quote_pages}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
