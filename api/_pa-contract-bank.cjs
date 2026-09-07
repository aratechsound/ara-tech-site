// Read only the hash-verified, frozen final quote. Never use another case/file or a default account.
function parseBankFooter(lines){
 const marked=lines.filter(s=>/<<\s*お振込先\s*>>/.test(s));
 if(!marked.length)return null; // Historical PDFs without this footer retain a source-document reference.
 const found=marked.map(line=>{
  const m=line.match(/^\s*<<\s*お振込先\s*>>\s*([^\s]+)\s+([^\s]+)\s+(普通|当座|貯蓄)\s+([0-9０-９]{7})\s+([^\r\n]+?)\s*$/u);
  if(!m)throw Error('quote_bank_unreadable');
  return {bank:m[1],branch:m[2],type:m[3],number:m[4],holder:m[5]};
 });
 if(new Set(found.map(v=>JSON.stringify(v))).size!==1)throw Error('quote_bank_ambiguous');
 return found[0];
}
async function bankFromQuote(bytes){
 let task;
 try{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  task=getDocument({data:new Uint8Array(bytes),verbosity:0,useWorkerFetch:false,useSystemFonts:false,disableFontFace:true,isEvalSupported:false});
  const doc=await task.promise,lines=[];
  for(let n=1;n<=doc.numPages;n++){
   const page=await doc.getPage(n),content=await page.getTextContent(),rows=[];
   for(const item of content.items){if(!item.str)continue;const y=item.transform[5];let row=rows.find(r=>Math.abs(r.y-y)<1);if(!row){row={y,items:[]};rows.push(row);}row.items.push(item);}
   for(const row of rows)lines.push(row.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(v=>v.str).join(' '));
  }
  return parseBankFooter(lines);
 }catch(e){throw Error(e.message==='quote_bank_ambiguous'?'quote_bank_ambiguous':'quote_bank_unreadable');}
 finally{if(task)await task.destroy();}
}
module.exports={parseBankFooter,bankFromQuote};
