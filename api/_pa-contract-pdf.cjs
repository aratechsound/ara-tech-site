const {PDFDocument,PDFName,PDFDict,PDFArray,rgb}=require('pdf-lib');
const fontkit=require('@pdf-lib/fontkit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const MAX_QUOTE_BYTES=1500000;
async function validatePdf(bytes,expectedHash) {
 if (!Buffer.isBuffer(bytes) || bytes.length<20 || bytes.length>MAX_QUOTE_BYTES || bytes.subarray(0,5).toString()!=='%PDF-' || !bytes.subarray(-2048).toString('latin1').includes('%%EOF')) throw Error('invalid_pdf');
 if(expectedHash && sha(bytes)!==expectedHash) throw Error('quote_identity_mismatch');
 let doc;
 try{
  doc=await PDFDocument.load(bytes,{throwOnInvalidObject:true});
  if(doc.isEncrypted || doc.getPageCount()<1 || doc.getPageCount()>30) throw Error('invalid_pdf');
 }catch{throw Error('invalid_pdf');}
 // Do not append active content, editable forms, file attachments or signed PDFs
 // whose signature would become misleading after a page merge.
 const forbidden=new Set(['OpenAction','AA','JavaScript','JS','Launch','EmbeddedFiles','XFA','AcroForm']);
 for(const [,obj] of doc.context.enumerateIndirectObjects()) {
  if(obj instanceof PDFDict) for(const key of obj.keys()) if(forbidden.has(key.decodeText())) throw Error('unsafe_pdf');
 }
 for(const page of doc.getPages()) {
  const annotations=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  if(annotations?.size())throw Error('unsafe_pdf');
 }
 return doc;
}
async function mergeReceipt(snapshot,quote) {
 const original=await validatePdf(quote,snapshot.quote.sha256);
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')),{subset:true});
 let page,y;const margin=44,width=507,lineHeight=17;
 const newPage=()=>{page=doc.addPage([595,842]);y=794;page.drawText('ARA-TECH  |  契約控え',{x:margin,y,font,size:15,color:rgb(0.05,0.22,0.4)});y-=36;};
 newPage();
 const paragraph=(value,size=10)=>{
  for(const raw of String(value).split('\n')){
   let line='';
   const put=()=>{if(y<60)newPage();page.drawText(line,{x:margin,y,font,size});y-=lineHeight;line='';};
   for(const char of raw){if(font.widthOfTextAtSize(line+char,size)>width)put();line+=char;}put();
  } y-=7;
 };
 paragraph('正式依頼の受付内容',14);
 paragraph(`イベント：${snapshot.event_name}\n開催日：${snapshot.event_date}\n顧客：${snapshot.customer_name}\n契約金額（税込）：${Number(snapshot.amount).toLocaleString('ja-JP')}円\n確認者：${snapshot.confirmer_name}\n確認日時（JST）：${snapshot.confirmed_at_jst}\n確認日時（UTC）：${new Date(snapshot.confirmed_at).toISOString()}`);
 paragraph(`依頼内容\n${snapshot.request_summary}`);
 paragraph(`契約ID：${snapshot.contract_id}\n案件ID：${snapshot.case_id}\n契約version：${snapshot.contract_version}\n規約version：${snapshot.terms_version}`,9);
 paragraph(`最終見積：${snapshot.quote.filename}\nファイルID：${snapshot.quote.file_id}\nSHA-256：${snapshot.quote.sha256}`,8);
 if(snapshot.payment_due_date)paragraph(`お支払期限：${snapshot.payment_due_date}`,11);
 for(const d of snapshot.related_documents||[])paragraph(`関連資料（金額根拠資料ではありません）：${d.filename}\nファイルID：${d.file_id}\nSHA-256：${d.sha256}`,8);
 paragraph('契約条件',14);paragraph(snapshot.terms_text);
 paragraph('以下に、お客様へ提示した最終見積PDFの原本ページを結合しています。',9);
 const coverPages=doc.getPageCount();
 for(const [i,p] of doc.getPages().entries())p.drawText(`条件ページ ${i+1} / ${coverPages}`,{x:margin,y:30,font,size:8});
 const pages=await doc.copyPages(original,original.getPageIndices());pages.forEach(p=>doc.addPage(p));
 // Retain the byte-exact source as an embedded file as well as copying its pages.
 await doc.attach(quote,'final-estimate-original.pdf',{mimeType:'application/pdf',description:`Original final estimate SHA-256 ${snapshot.quote.sha256}`});
 doc.setTitle('ARA-TECH 契約控え');doc.setAuthor('ARA-TECH');
 doc.setCreationDate(new Date(snapshot.confirmed_at));doc.setModificationDate(new Date(snapshot.confirmed_at));
 const bytes=Buffer.from(await doc.save());
 if(bytes.length>3*1024*1024)throw Error('receipt_too_large');
 return {bytes,sha256:sha(bytes),cover_pages:coverPages,quote_pages:pages.length};
}
module.exports={sha,validatePdf,mergeReceipt,MAX_QUOTE_BYTES};
