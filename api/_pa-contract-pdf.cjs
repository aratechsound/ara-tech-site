const {PDFDocument,PDFName,PDFDict,PDFArray,rgb}=require('pdf-lib');
const fontkit=require('@pdf-lib/fontkit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {honorific,japaneseDate,amount,postAcceptanceTerms}=require('./_pa-contract-display.cjs');
const {bankFromQuote}=require('./_pa-contract-bank.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const MAX_QUOTE_BYTES=1500000;
const BLUE=rgb(0,123/255,1),INK=rgb(23/255,43/255,62/255),MUTED=rgb(83/255,101/255,117/255),LINE=rgb(218/255,228/255,236/255),SOFT=rgb(246/255,249/255,252/255);

async function validatePdf(bytes,expectedHash) {
 if (!Buffer.isBuffer(bytes) || bytes.length<20 || bytes.length>MAX_QUOTE_BYTES || bytes.subarray(0,5).toString()!=='%PDF-' || !bytes.subarray(-2048).toString('latin1').includes('%%EOF')) throw Error('invalid_pdf');
 if(expectedHash && sha(bytes)!==expectedHash) throw Error('quote_identity_mismatch');
 let doc;
 try{
  doc=await PDFDocument.load(bytes,{throwOnInvalidObject:true});
  if(doc.isEncrypted || doc.getPageCount()<1 || doc.getPageCount()>30) throw Error('invalid_pdf');
 }catch{throw Error('invalid_pdf');}
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

function glyphPainter(font){
 const measure=(value,size)=>font.layout(String(value)).positions.reduce((sum,position)=>sum+position.xAdvance,0)*size/font.unitsPerEm;
 const draw=(page,value,x,baseline,size,color=INK,align='left')=>{
  const text=String(value??''),run=font.layout(text),scale=size/font.unitsPerEm;
  let cursor=align==='right'?x-measure(text,size):x;
  for(let index=0;index<run.glyphs.length;index++){
   const position=run.positions[index],svg=run.glyphs[index].path.scale(1,-1).toSVG();
   if(svg)page.drawSvgPath(svg,{x:cursor+position.xOffset*scale,y:baseline+position.yOffset*scale,scale,color});
   cursor+=position.xAdvance*scale;
  }
 };
 const lines=(value,size,width)=>{
  const result=[];
  for(const raw of String(value??'').split('\n')){
   if(!raw){result.push('');continue;}
   let line='';
   for(const char of raw){if(line&&measure(line+char,size)>width){result.push(line);line='';}line+=char;}
   if(line)result.push(line);
  }
  return result;
 };
 const paragraph=(page,value,{x,y,size=9,width=507,lineHeight=13,color=INK,maxLines=Infinity}={})=>{
  const wrapped=lines(value,size,width);
  if(wrapped.length>maxLines)throw Error('receipt_layout_overflow');
  for(const line of wrapped){if(line)draw(page,line,x,y,size,color);y-=lineHeight;}
  return y;
 };
 return {draw,measure,lines,paragraph};
}

const postAcceptPayment=terms=>String(terms.payment_terms||'').split(/\n\n+/u).filter(block=>{
 const value=block.trim();
 return value&&!value.startsWith('行政機関、法人、団体等で')&&!value.startsWith('請求書は原則としてPDF')&&!value.includes('正式依頼の前にARA-TECHへご相談');
}).join('\n\n');
const yen=value=>`¥${Number(value).toLocaleString('ja-JP')}（税込）`;

async function buildConfirmationReceipt(snapshot,quote) {
 const estimate=snapshot.estimate||{};
 const original=await validatePdf(quote,estimate.sha256);
 const event=snapshot.case||{},customer=snapshot.customer||{},terms=snapshot.terms||{},acceptance=snapshot.acceptance||{};
 const doc=await PDFDocument.create();
 const font=fontkit.create(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')));
 const paint=glyphPainter(font);
 const logo=await doc.embedPng(fs.readFileSync(path.join(__dirname,'../img/ara-tech-logo-horizontal-black.png')));
 const page1=doc.addPage([595,842]),page2=doc.addPage([595,842]);
 const margin=44,contentWidth=507;
 const topRule=page=>page.drawRectangle({x:0,y:832,width:595,height:10,color:BLUE});
 const label=(page,value,y)=>{paint.draw(page,value,margin,y,9,BLUE);page.drawLine({start:{x:margin,y:y-7},end:{x:551,y:y-7},thickness:.7,color:LINE});};
 const box=(page,{x=margin,y,width=contentWidth,height})=>page.drawRectangle({x,y,width,height,color:SOFT,borderColor:LINE,borderWidth:.8});
 const pair=(page,name,value,x,y,width)=>{paint.draw(page,name,x,y,7.5,MUTED);paint.paragraph(page,value,{x,y:y-17,size:9.5,width,lineHeight:13,maxLines:3});};
 topRule(page1);
 const logoWidth=166,logoHeight=logoWidth*logo.height/logo.width;
 page1.drawImage(logo,{x:551-logoWidth,y:794-logoHeight,width:logoWidth,height:logoHeight});
 paint.draw(page1,'担当：荒殿（アラドノ）',551,770,8.5,MUTED,'right');
 paint.draw(page1,'正式受注確認書',margin,730,22,INK);
 paint.draw(page1,'お客様とARA-TECH双方で保管する、正式受注成立時の確認書です。',margin,707,8.5,MUTED);
 label(page1,'ご依頼者／案件基本情報',682);box(page1,{y:562,height:103});
 pair(page1,'ご依頼者',[customer.organization,customer.department].filter(Boolean).join(' ')||customer.display_name,58,641,225);
 pair(page1,'ご担当者',honorific(customer.contact_name||customer.display_name),307,641,225);
 pair(page1,'案件',event.event_name,58,598,225);
 pair(page1,'開催日時',`${japaneseDate(event.event_date)}${event.event_time?' '+event.event_time:''}`,307,598,225);
 label(page1,'対象見積書',539);box(page1,{y:447,height:75});
 paint.paragraph(page1,estimate.original_filename,{x:58,y:495,size:11,width:475,lineHeight:14,maxLines:2});
 paint.draw(page1,`見積 第${estimate.revision_number||'-'}版`,58,466,8.5,MUTED);
 paint.draw(page1,yen(estimate.amount_minor),235,466,9.5,INK);
 paint.draw(page1,'本確認書3ページ目以降に原本を収録',533,466,8,MUTED,'right');
 label(page1,'ご依頼内容',423);box(page1,{y:337,height:69});
 paint.paragraph(page1,event.service_scope,{x:58,y:381,size:9.2,width:475,lineHeight:13,maxLines:3});
 label(page1,'キャンセル・変更条件',313);box(page1,{y:253,height:43});
 paint.draw(page1,'正式受注時に合意した条件を2ページ目に記録しています。',58,270,9,INK);
 label(page1,'お支払期限',229);box(page1,{y:170,height:42});
 paint.draw(page1,terms.payment_due_date?japaneseDate(terms.payment_due_date):terms.payment_terms,58,186,12,INK);
 label(page1,'正式受注成立情報',146);box(page1,{y:72,height:57});
 pair(page1,'確認者',acceptance.confirmer_name||snapshot.confirmer_name,58,109,225);
 pair(page1,'成立日時（日本時間）',snapshot.confirmed_at_jst||acceptance.confirmed_at||snapshot.confirmed_at,307,109,225);

 topRule(page2);
 paint.draw(page2,'詳細契約条件',margin,792,19,INK);
 paint.draw(page2,'正式受注時の条件控え',margin,770,8.5,MUTED);
 page2.drawLine({start:{x:margin,y:755},end:{x:551,y:755},thickness:1.1,color:BLUE});
 const frozenSections=[
  ['ご依頼内容',event.service_scope],
  ['キャンセル・変更条件',terms.cancellation_terms],
  ['お支払い',[terms.payment_due_date?`お支払期限：${japaneseDate(terms.payment_due_date)}`:'',postAcceptPayment(terms),terms.banking_day_treatment].filter(Boolean).join('\n')],
  ['請求書',terms.invoice_terms],
  ['振込手数料',terms.transfer_fee_terms],
  ['天候・日程変更',terms.weather_change_terms],
  ...(Array.isArray(terms.other_terms_sections)?terms.other_terms_sections.map(section=>[section.title,section.text]):[])
 ].filter(([,value])=>String(value||'').trim());
 const columnWidth=242,columnX=[44,309],bottom=58;
 let column=0,y=731;
 for(const [title,body] of frozenSections){
  const bodyLines=paint.lines(body,7.6,columnWidth-20),height=25+bodyLines.length*10.4+11;
  if(y-height<bottom){column++;y=731;}
  if(column>1||y-height<bottom)throw Error('receipt_layout_overflow');
  box(page2,{x:columnX[column],y:y-height+5,width:columnWidth,height:height-5});
  paint.draw(page2,title,columnX[column]+10,y-16,8.5,BLUE);
  let lineY=y-34;
  for(const line of bodyLines){if(line)paint.draw(page2,line,columnX[column]+10,lineY,7.6,INK);lineY-=10.4;}
  y-=height+8;
 }
 const copied=await doc.copyPages(original,original.getPageIndices());
 copied.forEach(page=>doc.addPage(page));
 const total=doc.getPageCount(),totalLabel=String(total).padStart(2,'0');
 [page1,page2].forEach((page,index)=>paint.draw(page,`${String(index+1).padStart(2,'0')} / ${totalLabel}`,551,28,8,MUTED,'right'));
 doc.setTitle('ARA-TECH 正式受注確認書');doc.setAuthor('ARA-TECH');doc.setSubject('正式受注内容と正式受注時にbindされた見積書原本');
 const fixed=new Date(acceptance.confirmed_at||snapshot.confirmed_at);if(Number.isFinite(+fixed)){doc.setCreationDate(fixed);doc.setModificationDate(fixed);}
 const bytes=Buffer.from(await doc.save());if(bytes.length>3*1024*1024)throw Error('receipt_too_large');
 return {bytes,sha256:sha(bytes),cover_pages:2,quote_pages:copied.length};
}

async function mergeReceipt(snapshot,quote) {
 const original=await validatePdf(quote,snapshot.quote.sha256);
 const receiptTerms=postAcceptanceTerms(snapshot,await bankFromQuote(quote));
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')),{subset:true});
 const logo=await doc.embedPng(fs.readFileSync(path.join(__dirname,'../img/ara-tech-logo-horizontal-white.png')));
 let page,y;const margin=44,width=507,lineHeight=16;
 const newPage=()=>{page=doc.addPage([595,842]);page.drawRectangle({x:0,y:768,width:595,height:74,color:BLUE});page.drawImage(logo,{x:margin,y:792,width:166,height:166*logo.height/logo.width});y=740;};
 newPage();
 const paragraph=(value,size=10,keepTogether=false)=>{
  if(keepTogether){let count=0;for(const raw of String(value).split('\n')){let line='';count++;for(const char of raw){if(font.widthOfTextAtSize(line+char,size)>width){count++;line='';}line+=char;}}const height=count*lineHeight;if(height<=680&&y-height<60)newPage();}
  for(const raw of String(value).split('\n')){let line='';const put=()=>{if(y<60)newPage();page.drawText(line,{x:margin,y,font,size});y-=lineHeight;line='';};for(const char of raw){if(font.widthOfTextAtSize(line+char,size)>width)put();line+=char;}put();} y-=7;
 };
 paragraph('正式受注内容確認書',18);
 paragraph(`イベント：${snapshot.event_name}\n開催日：${japaneseDate(snapshot.event_date)}${snapshot.order_scope?`\n本番時間：${snapshot.order_scope.performance_time}\n会場：${snapshot.order_scope.venue}`:''}\n顧客：${honorific(snapshot.customer_name)}\nご依頼金額：${amount(snapshot.amount)}\n確認者氏名：${snapshot.confirmer_name}\n確認日時（JST）：${snapshot.confirmed_at_jst}\n契約番号：${snapshot.contract_id}`);
 paragraph('ご依頼内容',13);paragraph(snapshot.order_scope?.services||snapshot.request_summary);
 for(const block of receiptTerms.split('\n\n'))paragraph(block,10,true);
 for(const d of snapshot.related_documents||[])paragraph(`関連資料：${d.filename}\n（契約金額の根拠となる最終見積書とは別の資料です。）`,9);
 paragraph(`最終見積書：${snapshot.quote.filename}`,9);paragraph('以下に、お客様へ提示した最終見積PDFの原本ページを結合しています。',9);
 const coverPages=doc.getPageCount();for(const [i,p] of doc.getPages().entries())p.drawText(`条件ページ ${i+1} / ${coverPages}`,{x:margin,y:30,font,size:8});
 const pages=await doc.copyPages(original,original.getPageIndices());pages.forEach(p=>doc.addPage(p));
 await doc.attach(quote,'final-estimate-original.pdf',{mimeType:'application/pdf',description:'最終見積書の原本'});
 doc.setTitle('ARA-TECH 契約控え');doc.setAuthor('ARA-TECH');doc.setCreationDate(new Date(snapshot.confirmed_at));doc.setModificationDate(new Date(snapshot.confirmed_at));
 const bytes=Buffer.from(await doc.save());if(bytes.length>3*1024*1024)throw Error('receipt_too_large');
 return {bytes,sha256:sha(bytes),cover_pages:coverPages,quote_pages:pages.length};
}
const createReceipt=(snapshot,quote)=>snapshot?.snapshot_schema_version==='PA-FORMAL-V5-20260914-1'?buildConfirmationReceipt(snapshot,quote):mergeReceipt(snapshot,quote);
module.exports={sha,validatePdf,mergeReceipt,createReceipt,MAX_QUOTE_BYTES};
