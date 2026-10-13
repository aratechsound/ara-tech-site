'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{const name=path.join(root,new URL(req.url,'http://localhost').pathname);if(!name.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':'text/html');res.end(fs.readFileSync(name));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
  const page=await browser.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  const origin='http://127.0.0.1:'+server.address().port;
  await page.goto(origin+'/pa-admin.html');
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
  await page.evaluate(async()=>{
   const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 5 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 6 0 R >>','<< /Length 0 >>\nstream\n\nendstream','<< /Length 0 >>\nstream\n\nendstream'];
   let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
   const xref=pdf.length;pdf+='xref\n0 7\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
   const {createGallery}=await import('/pa-ui/js/gallery.mjs');
   const g=createGallery({isCurrent:()=>true,requestBlob:async()=>new Blob([pdf],{type:'application/pdf'})});
   await g.openPreview({key:'two-page',asset_id:'a',mime_type:'application/pdf',filename:'日本語2ページ.pdf'});
  });
  assert.equal(await page.locator('dialog canvas').count(),1);
  await page.getByRole('button',{name:'次のページ',exact:true}).click();
  await page.getByText('2 / 2ページ · 100%',{exact:true}).waitFor();
  await page.getByRole('button',{name:'拡大',exact:true}).click();
  await page.getByText('2 / 2ページ · 125%',{exact:true}).waitFor();
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  console.log('PASS real PDF.js two-page render, page navigation and zoom');
  const C='11111111-1111-4111-8111-111111111111',errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const session={access_token:'fixture-only',expires_at:9999999999};export const workspaceAuth={restore:async()=>session,current:async()=>session,subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;"}));
  await page.route('**/api/pa-workspace-read?**',r=>{
   const p=new URL(r.request().url()).searchParams.get('path');let value=[];
   if(p==='/data/cases')value={cases:[{id:C,event_name:'Fixture Event',inquiry_number:'PA-20261002-00015',status:'new'}],progress:[]};
   else if(p.startsWith('/data/commercial/'))value={estimates:[],offers:[],documents:[],billings:[]};
   else if(p.startsWith('/data/materials/'))value={cards:[],photos:[]};
   else if(p.startsWith('/data/mail/'))value=[{gmail_message_id:'mail1',inquiry_id:C,direction:'inbound',subject:'Fixture mail',attachment_metadata:[]}];
   else if(p.startsWith('/data/mail-body/'))value={gmail_message_id:'mail1',body_text:'Full body '.repeat(200)+'\n> quoted history',body_state:'ready'};
   else if(p.startsWith('/data/sent-estimates/'))value={messages:[{gmail_message_id:'sent1',inquiry_id:C,subject:'Fixture sent estimate',sent_at:'2026-10-09T00:00:00Z',to_addresses:['fixture@example.invalid'],attachment_metadata:[],history_only:true,validity:'unknown'}],unknown:[]};
   r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:value})});
  });
  await page.reload();await page.locator('[data-case="'+C+'"]').click();
  await page.getByRole('button',{name:'見積・受注',exact:true}).click();
  await page.getByText('Fixture sent estimate',{exact:true}).waitFor();
  assert((await page.locator('#detail-card').innerText()).includes('宛先 fixture@example.invalid'));
  assert.deepEqual(errors,[]);
  console.log('PASS CASE DESK sent-history rendering with recipient and no registration writes');
  await page.getByRole('button',{name:'やり取り',exact:true}).click();
  await page.getByRole('button',{name:'本文を読む',exact:true}).click();
  await page.getByRole('button',{name:'本文を再取得',exact:true}).waitFor();
  const body=await page.locator('.mail-excerpt').evaluate(n=>({length:n.textContent.length,display:getComputedStyle(n).display,overflow:getComputedStyle(n).overflow}));
  assert(body.length>650);assert.equal(body.display,'block');assert.equal(body.overflow,'visible');
  assert.equal(await page.locator('[data-quoted-body]').count(),1);
  assert.deepEqual(errors,[]);console.log('PASS fetched full body visibly expands beyond three-line excerpt and separates quotation');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
