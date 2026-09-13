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
async function buildConfirmationReceipt(snapshot,quote) {
 const estimate=snapshot.estimate||{};
 await validatePdf(quote,estimate.sha256);
 const event=snapshot.case||{},customer=snapshot.customer||{},terms=snapshot.terms||{},acceptance=snapshot.acceptance||{};
 const doc=await PDFDocument.create();
 const font=fontkit.create(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')));
 const logo=await doc.embedPng(fs.readFileSync(path.join(__dirname,'../img/ara-tech-logo-horizontal-white.png')));
 let page,y;const margin=44,width=507,lineHeight=16;
 const newPage=()=>{page=doc.addPage([595,842]);page.drawRectangle({x:0,y:768,width:595,height:74,color:rgb(0,123/255,1)});page.drawImage(logo,{x:margin,y:792,width:166,height:166*logo.height/logo.width});y=740;};
 const measure=(value,size)=>font.layout(String(value)).positions.reduce((sum,position)=>sum+position.xAdvance,0)*size/font.unitsPerEm;
 const drawLine=(value,x,baseline,size,color=rgb(28/255,45/255,61/255))=>{
  const run=font.layout(String(value)),scale=size/font.unitsPerEm;let cursor=x;
  for(let index=0;index<run.glyphs.length;index++){
   const position=run.positions[index],svg=run.glyphs[index].path.scale(1,-1).toSVG();
   if(svg)page.drawSvgPath(svg,{x:cursor+position.xOffset*scale,y:baseline+position.yOffset*scale,scale,color});
   cursor+=position.xAdvance*scale;
  }
 };
 const paragraph=(value,size=10,gap=7)=>{
  for(const raw of String(value||'').split('\n')){
   if(!raw){y-=lineHeight*.55;continue;}
   let line='';
   const put=()=>{if(y<62)newPage();if(line)drawLine(line,margin,y,size);y-=lineHeight;line='';};
   for(const char of raw){if(line&&measure(line+char,size)>width)put();line+=char;}put();
  }
  y-=gap;
 };
 const heading=value=>{if(y<105)newPage();paragraph(value,13,5);};
 newPage();
 paragraph('正式受注確認書',18,14);
 paragraph(`イベント名\n${event.event_name}\n\n開催日時\n${japaneseDate(event.event_date)}${event.event_time?' '+event.event_time:''}`);
 if(customer.organization)paragraph(`ご依頼者\n${customer.organization}${customer.department?' '+customer.department:''}`);
 paragraph(`ご担当者\n${honorific(customer.contact_name||customer.display_name)}`);
 paragraph(`対象見積\n第${estimate.revision_number||'-'}版\n\n見積金額\n${amount(estimate.amount_minor)}`);
 heading('ご依頼内容');paragraph(event.service_scope);
 heading('キャンセル・変更条件');paragraph(terms.cancellation_terms);
 heading('支払期限');paragraph(terms.payment_due_date?japaneseDate(terms.payment_due_date):terms.payment_terms);
 heading('支払時期について');paragraph(terms.payment_consult_terms||'所定のお手続き等によりお支払時期の調整が必要な場合は、事前にご相談ください。');
 heading('正式受注の確認');paragraph(`確認者：${acceptance.confirmer_name||snapshot.confirmer_name}\n成立日時（日本時間）：${snapshot.confirmed_at_jst||acceptance.confirmed_at||snapshot.confirmed_at}`);
 paragraph('このたびは正式にご依頼いただきありがとうございます。確認内容を受け付けました。',10,16);
 paragraph('ARA-TECH',11,0);
 const count=doc.getPageCount();for(const [i,p] of doc.getPages().entries()){page=p;drawLine(`${i+1} / ${count}`,520,28,8,rgb(.35,.4,.45));}
 doc.setTitle('ARA-TECH Formal Order Receipt');doc.setAuthor('ARA-TECH');
 const fixed=new Date(acceptance.confirmed_at||snapshot.confirmed_at);if(Number.isFinite(+fixed)){doc.setCreationDate(fixed);doc.setModificationDate(fixed);}
 const bytes=Buffer.from(await doc.save());if(bytes.length>3*1024*1024)throw Error('receipt_too_large');
 return {bytes,sha256:sha(bytes),cover_pages:count,quote_pages:0};
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
const createReceipt=(snapshot,quote)=>snapshot?.snapshot_schema_version==='PA-FORMAL-V5-20260914-1'?buildConfirmationReceipt(snapshot,quote):mergeReceipt(snapshot,quote);
module.exports={sha,validatePdf,mergeReceipt,createReceipt,MAX_QUOTE_BYTES};
