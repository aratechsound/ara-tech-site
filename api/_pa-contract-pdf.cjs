const {PDFDocument,PDFName,PDFDict,PDFArray,rgb}=require('pdf-lib');
const fontkit=require('@pdf-lib/fontkit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {honorific,japaneseDate,amount,postAcceptanceTerms}=require('./_pa-contract-display.cjs');
const {bankFromQuote}=require('./_pa-contract-bank.cjs');
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
 const receiptTerms=postAcceptanceTerms(snapshot,await bankFromQuote(quote));
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')),{subset:true});
 const logo=await doc.embedPng(fs.readFileSync(path.join(__dirname,'../img/ara-tech-logo-horizontal-white.png')));
 let page,y;const margin=44,width=507,lineHeight=16;
 const newPage=()=>{page=doc.addPage([595,842]);page.drawRectangle({x:0,y:768,width:595,height:74,color:rgb(0,123/255,1)});page.drawImage(logo,{x:margin,y:792,width:166,height:166*logo.height/logo.width});y=740;};
 newPage();
 const paragraph=(value,size=10,keepTogether=false)=>{
  if(keepTogether){let count=0;for(const raw of String(value).split('\n')){let line='';count++;for(const char of raw){if(font.widthOfTextAtSize(line+char,size)>width){count++;line='';}line+=char;}}const height=count*lineHeight;if(height<=680&&y-height<60)newPage();}
  for(const raw of String(value).split('\n')){
   let line='';
   const put=()=>{if(y<60)newPage();page.drawText(line,{x:margin,y,font,size});y-=lineHeight;line='';};
   for(const char of raw){if(font.widthOfTextAtSize(line+char,size)>width)put();line+=char;}put();
  } y-=7;
 };
 paragraph('正式受注内容確認書',18);
 paragraph(`イベント：${snapshot.event_name}\n開催日：${japaneseDate(snapshot.event_date)}${snapshot.order_scope?`\n本番時間：${snapshot.order_scope.performance_time}\n会場：${snapshot.order_scope.venue}`:''}\n顧客：${honorific(snapshot.customer_name)}\nご依頼金額：${amount(snapshot.amount)}\n確認者氏名：${snapshot.confirmer_name}\n確認日時（JST）：${snapshot.confirmed_at_jst}\n契約番号：${snapshot.contract_id}`);
 paragraph('ご依頼内容',13);paragraph(snapshot.order_scope?.services||snapshot.request_summary);
 // Keep cancellation/other agreed terms; payment displays confirmed facts and the original quote's bank footer.
 for(const block of receiptTerms.split('\n\n'))paragraph(block,10,true);
 for(const d of snapshot.related_documents||[])paragraph(`関連資料：${d.filename}\n（契約金額の根拠となる最終見積書とは別の資料です。）`,9);
 paragraph(`最終見積書：${snapshot.quote.filename}`,9);
 paragraph('以下に、お客様へ提示した最終見積PDFの原本ページを結合しています。',9);
 const coverPages=doc.getPageCount();
 for(const [i,p] of doc.getPages().entries())p.drawText(`条件ページ ${i+1} / ${coverPages}`,{x:margin,y:30,font,size:8});
 const pages=await doc.copyPages(original,original.getPageIndices());pages.forEach(p=>doc.addPage(p));
 // Retain the byte-exact source as an embedded file as well as copying its pages.
 await doc.attach(quote,'final-estimate-original.pdf',{mimeType:'application/pdf',description:'最終見積書の原本'});
 doc.setTitle('ARA-TECH 契約控え');doc.setAuthor('ARA-TECH');
 doc.setCreationDate(new Date(snapshot.confirmed_at));doc.setModificationDate(new Date(snapshot.confirmed_at));
 const bytes=Buffer.from(await doc.save());
 if(bytes.length>3*1024*1024)throw Error('receipt_too_large');
 return {bytes,sha256:sha(bytes),cover_pages:coverPages,quote_pages:pages.length};
}
module.exports={sha,validatePdf,mergeReceipt,MAX_QUOTE_BYTES};
