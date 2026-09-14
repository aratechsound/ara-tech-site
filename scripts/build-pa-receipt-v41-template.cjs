const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
const {PDFDocument}=require('pdf-lib');

const EXPECTED_SOURCE_SHA='f988d8f8d510ad61087d9de8dca7af29eeeca143c938eb63bf379367c10bdb5d';
const DEFAULT_SOURCE='E:\\ダウンロード\\pa-est-005-receipt-design-mock-v4-1-final.html';
const DEFAULT_OUTPUT=path.join(__dirname,'..','api','contract-assets','pa-receipt-v4-1-template.pdf');
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function pageFragment(source,id,nextId){
 const start=source.indexOf(`<div class="page-frame" id="${id}">`);
 const end=nextId?source.indexOf(`<div class="page-frame" id="${nextId}">`,start):source.indexOf('</main>',start);
 if(start<0||end<0)throw Error(`authority_${id}_missing`);
 return source.slice(start,end);
}

function pageHtml(source,id,nextId,extraCss){
 const headEnd=source.indexOf('</head>');
 if(headEnd<0)throw Error('authority_head_missing');
 let frame=pageFragment(source,id,nextId);
 if(id==='page2')frame=frame.replace('class="sheet appendix"','class="sheet"');
 return `${source.slice(0,headEnd)}<style>${extraCss}</style></head><body><main id="pages">${frame}</main></body></html>`;
}

function printPage(htmlPath,pdfPath,profilePath){
 const result=spawnSync(EDGE,[
  '--headless','--disable-gpu','--no-pdf-header-footer','--print-background',
  '--run-all-compositor-stages-before-draw',`--user-data-dir=${profilePath}`,
  `--print-to-pdf=${pdfPath}`,pathToFileURL(htmlPath).href
 ],{encoding:'utf8',windowsHide:true,timeout:60000});
 if(result.error||result.status!==0||!fs.existsSync(pdfPath))throw Error(`edge_print_failed:${result.error?.message||result.stderr||result.status}`);
}

async function main(){
 const sourcePath=path.resolve(process.argv[2]||DEFAULT_SOURCE),outputPath=path.resolve(process.argv[3]||DEFAULT_OUTPUT);
 const sourceBytes=fs.readFileSync(sourcePath),sourceHash=sha(sourceBytes);
 if(sourceHash!==EXPECTED_SOURCE_SHA)throw Error(`authority_hash_mismatch:${sourceHash}`);
 const source=sourceBytes.toString('utf8'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pa-receipt-v41-'));
 const page1Css='.sample-tag,.org,.person,.event-title,.info-value,.quote-value,.quote-cell:first-child>div>div,.quote-note,.cancel-table tbody td:nth-child(2),.payment-date,.confirm-head span,.confirm-data .value,.page-num{visibility:hidden!important}';
 const page2Css='.sample-tag,.ref-row strong,.ref-row span,.keep-note strong,.page-num{visibility:hidden!important}';
 const page1Html=path.join(temp,'page1.html'),page2Html=path.join(temp,'page2.html'),page1Pdf=path.join(temp,'page1.pdf'),page2Pdf=path.join(temp,'page2.pdf');
 fs.writeFileSync(page1Html,pageHtml(source,'page1','page2',page1Css));
 fs.writeFileSync(page2Html,pageHtml(source,'page2','page3',page2Css));
 printPage(page1Html,page1Pdf,path.join(temp,'edge-profile-1'));
 printPage(page2Html,page2Pdf,path.join(temp,'edge-profile-2'));
 const first=await PDFDocument.load(fs.readFileSync(page1Pdf)),second=await PDFDocument.load(fs.readFileSync(page2Pdf)),output=await PDFDocument.create();
 output.addPage((await output.copyPages(first,[0]))[0]);
 const {width:pageWidth,height:pageHeight}=first.getPage(0).getSize(),bandHeight=mm(16.5),page2=output.addPage([pageWidth,pageHeight]);
 const page2Surface=await output.embedPage(second.getPage(0)),authorityBand=await output.embedPage(first.getPage(0),{left:0,bottom:pageHeight-bandHeight,right:pageWidth,top:pageHeight});
 page2.drawPage(page2Surface,{x:0,y:0,width:pageWidth,height:pageHeight});
 // Both Edge and WeasyPrint reserve Page 2's band geometry but omit its paint.
 // Reuse the exact Page 1 authority band rather than recreating it.
 page2.drawPage(authorityBand,{x:0,y:pageHeight-bandHeight,width:pageWidth,height:bandHeight});
 const fixed=new Date('2026-09-14T00:00:00Z');output.setTitle('ARA-TECH Receipt V4.1 fixed template');output.setAuthor('ARA-TECH');output.setCreationDate(fixed);output.setModificationDate(fixed);
 const bytes=Buffer.from(await output.save());fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,bytes);
 console.log(JSON.stringify({source:sourcePath,source_sha256:sourceHash,output:outputPath,template_sha256:sha(bytes),pages:output.getPageCount(),bytes:bytes.length}));
}
function mm(value){return value*72/25.4;}
main().catch(error=>{console.error(error);process.exitCode=1;});
