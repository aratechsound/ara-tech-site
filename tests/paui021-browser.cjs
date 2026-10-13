'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{const name=path.join(root,new URL(req.url,'http://localhost').pathname);if(!name.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':'text/html');res.end(fs.readFileSync(name));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');
  const result=await page.evaluate(async()=>{
   const {fullBody,htmlText,mailAttachments}=await import('/pa-ui/js/mail-model.mjs');
   const {createGallery}=await import('/pa-ui/js/gallery.mjs');
   const html='<p>新しい本文</p><img src="https://invalid.example/track"><script>window.compromised=true</script><blockquote>古い本文</blockquote>';
   const safe=htmlText(html,document,true),parts=fullBody({body_html:html});
   const long=fullBody({body_text:'x'.repeat(2000)+'\n> quote'});
   const rows=mailAttachments({gmail_message_id:'m',attachment_metadata:Array.from({length:6},(_,i)=>({id:'a'+i,filename:'日本語'+i+'.png',mime_type:'image/png'}))});
   const host=document.createElement('div');document.body.append(host);
   const g=createGallery({isCurrent:()=>true,requestBlob:async()=>{throw {status:403};}});g.mount(host,rows,{compact:true});
   const names=[...host.querySelectorAll('.material-name')].map(n=>n.textContent);g.dispose();
   return {safe,parts,long,names,empty:fullBody({body_text:''}),compromised:Boolean(window.compromised),remoteImages:document.querySelectorAll('img[src="https://invalid.example/track"]').length};
  });
  assert(result.safe.includes('新しい本文')&&result.safe.includes('古い本文'));
  assert(!result.safe.includes('compromised'));assert(!result.compromised);assert.equal(result.remoteImages,0);
  assert(result.parts.text.includes('新しい本文'));assert(result.parts.quoted.includes('古い本文'));
  assert.equal(result.long.text.length,2000);assert(result.long.quoted.includes('quote'));assert(result.empty.empty);
  assert.deepEqual(result.names,Array.from({length:6},(_,i)=>'日本語'+i+'.png'));
  console.log('PASS HTML inert text, full body, quotation, empty, Japanese filenames, six attachments in original order');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
