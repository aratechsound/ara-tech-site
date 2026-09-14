const {PDFDocument,PDFName,PDFDict,PDFArray,rgb}=require('pdf-lib');
const fontkit=require('@pdf-lib/fontkit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {honorific,japaneseDate,amount,postAcceptanceTerms}=require('./_pa-contract-display.cjs');
const {bankFromQuote}=require('./_pa-contract-bank.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const MAX_QUOTE_BYTES=1500000;
const BLUE=rgb(0,123/255,1),INK=rgb(23/255,46/255,69/255),BODY=rgb(41/255,62/255,80/255),MUTED=rgb(101/255,122/255,142/255);
const PT_PER_MM=72/25.4;
const mm=value=>value*PT_PER_MM;
const RECEIPT_V41_TEMPLATE_SHA='d9dc133719b21012ef7522db75502d5e081883c1da5a57fc5a5adafb4e6a8d52';
const RECEIPT_SERVICE_FALLBACK='対象見積書記載の業務';
const SERVICE_LABELS=new Map([
 ['PA・音響','PA・音響'],
 ['照明','照明'],
 ['DJ機材','DJ機材'],
 ['バンド機材','バンド機材'],
 ['電源・発電機','電源対応'],
 ['ステージ制作・舞台設営','ステージ制作・舞台設営'],
 ['オペレーター・技術スタッフ','技術スタッフ'],
 ['その他','その他業務']
]);

const normalizeDisplayText=value=>String(value??'')
 .normalize('NFC')
 .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd\u25a0\u25a1]+/gu,' ')
 .replace(/\s+/gu,' ')
 .trim();

function customerServiceSummary(event={}){
 const structured=Array.isArray(event.requested_services)?event.requested_services:[];
 let labels=structured.map(normalizeDisplayText).filter(Boolean);
 if(!labels.length){
  const raw=String(event.service_scope??'').replace(/\r\n?/gu,'\n');
  const requested=raw.split('\n').map(line=>line.trim()).find(line=>/^希望業務\s*[：:]/u.test(line));
  if(requested)labels=requested.replace(/^希望業務\s*[：:]\s*/u,'').split(/[、,，]+/u).map(normalizeDisplayText).filter(Boolean);
  else if(!raw.includes('\n')){
   const direct=normalizeDisplayText(raw).replace(/\s*[／/]\s*詳しくは対象見積書をご確認ください。?$/u,'');
   if(direct)labels=[direct];
  }
 }
 const normalized=[...new Set(labels.map(label=>SERVICE_LABELS.get(label)||label).map(normalizeDisplayText).filter(Boolean))].join('・');
 return normalized||RECEIPT_SERVICE_FALLBACK;
}

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
   const position=run.positions[index],svg=run.glyphs[index].path.mapPoints((x,y)=>[x,-y]).toSVG();
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
 // The fixed visual surface is printed directly from the Owner-approved V4.1
 // HTML/CSS. Only the explicitly hidden mock/dynamic fields are painted here.
 const templateBytes=fs.readFileSync(path.join(__dirname,'contract-assets','pa-receipt-v4-1-template.pdf'));
 if(sha(templateBytes)!==RECEIPT_V41_TEMPLATE_SHA)throw Error('receipt_template_invalid');
 let template;
 try{template=await PDFDocument.load(templateBytes,{throwOnInvalidObject:true});}catch{throw Error('receipt_template_invalid');}
 if(template.getPageCount()!==2)throw Error('receipt_template_invalid');
 const doc=await PDFDocument.create(),embedded=await doc.embedPdf(templateBytes,[0,1]),templateSize=template.getPage(0).getSize();
 const page1=doc.addPage([templateSize.width,templateSize.height]),page2=doc.addPage([templateSize.width,templateSize.height]);
 page1.drawPage(embedded[0],{x:0,y:0,width:templateSize.width,height:templateSize.height});
 page2.drawPage(embedded[1],{x:0,y:0,width:templateSize.width,height:templateSize.height});
 const fontBytes=fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')),paint=glyphPainter(fontkit.create(fontBytes));
 const margin=mm(16),right=templateSize.width-margin,width=templateSize.width-mm(32);
 const bold=(page,value,x,y,size,color=INK,align='left')=>{
  const dx=align==='right'?-0.24:0.24;
  paint.draw(page,value,x,y,size,color,align);paint.draw(page,value,x+dx,y,size,color,align);
  paint.draw(page,value,x,y+.18,size,color,align);paint.draw(page,value,x+dx,y+.18,size,color,align);
 };
 const paragraph=(page,value,options={})=>paint.paragraph(page,value,{color:BODY,...options});
 const shortDate=value=>{const d=new Date(`${value}T00:00:00Z`);return Number.isFinite(+d)?`${d.getUTCMonth()+1}月${d.getUTCDate()}日`:String(value||'');};
 const acceptedAt=()=>{
  const value=acceptance.confirmed_at||snapshot.confirmed_at;
  if(!value)return '';
  const d=new Date(value);if(!Number.isFinite(+d))return String(value);
  const parts=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d),get=t=>parts.find(p=>p.type===t)?.value;
  return `${get('year')}年${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`;
 };

 paint.draw(page1,[customer.organization,customer.department].filter(Boolean).join(' ')||customer.display_name,margin,698,10,BODY);
 bold(page1,honorific(customer.contact_name||customer.display_name),margin,673,14,INK);
 bold(page1,event.event_name,margin+11,611.5,12.5,INK);
 const infoRows=[['開催日時',`${japaneseDate(event.event_date)}${event.event_time?' '+event.event_time:''}（予定）`],['会場',event.venue],['対象業務',`${customerServiceSummary(event)}／詳しくは対象見積書をご確認ください。`]];
 const infoBaselineAdjust=[.5,2,1];
 for(let i=0;i<3;i++){
  const y=598-i*27.3,baseline=y-18+infoBaselineAdjust[i];
  if(i!==2){paint.draw(page1,infoRows[i][1],margin+94,baseline,9.7,BODY);continue;}
  const cellWidth=right-(margin+94)-7,wrapped=paint.lines(normalizeDisplayText(infoRows[i][1]),9.7,cellWidth);
  if(!wrapped.length||wrapped.length>2||wrapped.some(line=>paint.measure(line,9.7)>cellWidth))throw Error('receipt_layout_overflow');
  const firstBaseline=baseline+(wrapped.length-1)*5.25;
  wrapped.forEach((line,index)=>paint.draw(page1,line,margin+94,firstBaseline-index*10.5,9.7,BODY));
 }
 paragraph(page1,estimate.original_filename,{x:margin+62,y:487,size:9.1,width:176,lineHeight:15,maxLines:2,color:INK});
 paint.draw(page1,`見積 第${estimate.revision_number||'-'}版／本確認書3枚目以降に原本を収録`,margin+62,455,8,MUTED);
 bold(page1,`${Number(estimate.amount_minor).toLocaleString('ja-JP')}円`,margin+width/2+70,487,11.5,INK);
 const bands=Array.isArray(terms.cancellation_bands)?terms.cancellation_bands:[];
 if(bands.length!==4)throw Error('receipt_layout_overflow');
 const dateValues=bands.map(b=>b.from?`${shortDate(b.from)}〜${shortDate(b.to)}`:`${shortDate(b.to)}まで`);
 dateValues.forEach((value,index)=>paint.draw(page1,value,margin+78,354-index*24.5,8.25,BODY));
 bold(page1,terms.payment_due_date?japaneseDate(terms.payment_due_date):terms.payment_terms,margin+289,371.5,12.5,INK);
 bold(page1,honorific(acceptance.confirmer_name||snapshot.confirmer_name),margin+12,101,9.8,INK);
 bold(page1,acceptedAt(),margin+216,101,9.8,INK);

 const {issuanceTermsV4}=require('./_pa-contract-terms.cjs'),expected=issuanceTermsV4(event.event_date);
 const normalizedSections=value=>(Array.isArray(value)?value:[]).filter(section=>section.title!=='その他').map(section=>({title:section.title,text:section.text}));
 if(JSON.stringify(normalizedSections(terms.other_terms_sections))!==JSON.stringify(normalizedSections(expected.other_terms_sections))||terms.invoice_terms!==expected.invoice_terms||terms.transfer_fee_terms!==expected.transfer_fee_terms)throw Error('receipt_layout_overflow');
 bold(page2,event.event_name,margin,692,9,MUTED);paint.draw(page2,`対象：見積 第${estimate.revision_number||'-'}版`,right,692,9,MUTED,'right');
 const copied=await doc.copyPages(original,original.getPageIndices());copied.forEach(page=>doc.addPage(page));
 const total=doc.getPageCount(),totalLabel=String(total).padStart(2,'0');
 bold(page2,`本書は${total}ページ構成です`,margin+11,129,9.5,rgb(41/255,78/255,107/255));
 if(copied.length>1){
  page2.drawRectangle({x:margin+10,y:84,width:width-20,height:38,color:rgb(243/255,249/255,1)});
  paint.draw(page2,'ご依頼内容・金額・キャンセル条件・支払期限は1枚目、詳しい条件はこの2枚目、',margin+11,108,8.6,rgb(72/255,104/255,128/255));
  paint.draw(page2,'対象見積書は3枚目以降をご確認ください。',margin+11,91,8.6,rgb(72/255,104/255,128/255));
 }
 [page1,page2].forEach((page,index)=>paint.draw(page,`${String(index+1).padStart(2,'0')} / ${totalLabel}`,right,27,8,MUTED,'right'));
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
module.exports={sha,validatePdf,mergeReceipt,createReceipt,customerServiceSummary,normalizeDisplayText,MAX_QUOTE_BYTES,RECEIPT_V41_TEMPLATE_SHA};
