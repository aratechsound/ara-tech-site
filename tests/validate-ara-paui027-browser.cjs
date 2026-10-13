'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const fixture=await import('./paui027-fixture.mjs'),{A,B,values,request,pdf,image}=fixture;
 const {warehouseItems,inquiryFields,filterWarehouse}=await import('../pa-ui/js/document-warehouse.mjs');
 const items=warehouseItems({materials:values['/data/materials/'+A],commercial:values['/data/commercial/'+A],messages:values['/data/mail/'+A],sentEstimates:values['/data/sent-estimates/'+A],inquiry:values['/data/cases'].cases[0]});
 assert.equal(items.filter(d=>d.message_id==='quote').length,1,'exact message/part identity merged');
 assert.equal(items.filter(d=>d.filename==='会場図_同じ名前.pdf').length,3,'same names with different identities retained');
 assert.equal(items.find(d=>d.asset_id==='v1').portal_current,'ポータル現在版');assert.equal(items.find(d=>d.asset_id==='v3').latest_state,'最新登録版');assert(items.every(d=>d.valid_state==='未確認'));
 assert.equal(inquiryFields(values['/data/cases'].cases[0]).find(d=>d.label.startsWith('依頼内容')).value,request);
 assert.equal(filterWarehouse(items,{kind:'見積書',source:'commercial'}).length,3);
 assert.equal(filterWarehouse(items,{term:'第2版',from:'2026-10-02',to:'2026-10-02'}).length,1);
 const root=process.env.PAUI027_SOURCE||path.resolve(__dirname,'..'),baseline=!!process.env.PAUI027_BASELINE;
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],calls=[];let deny=false;
 page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
 await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only'}),current:async()=>({access_token:'fixture-only'}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
 await page.route('**/api/pa-workspace-read?**',async r=>{const p=new URL(r.request().url()).searchParams.get('path');calls.push({path:p,method:r.request().method()});
 if(deny&&p.startsWith('/data/commercial/'))return r.fulfill({status:403,json:{ok:false,code:'acl_denied'}});
 if(/\/data\/(material|document|mail-attachment|sent-estimate-attachment)\//.test(p)){
   if(p.endsWith('/part8'))return r.fulfill({status:403,json:{ok:false,code:'attachment_mail_mismatch'}});
   return r.fulfill({contentType:p.endsWith('/part7')?'image/png':'application/pdf',body:p.endsWith('/part7')?Buffer.from(image,'base64'):pdf()});
 }
 return r.fulfill({json:{ok:true,result:values[p]??[]}});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('#inspector').getByText('顧客回答待ち',{exact:true}).waitFor();
 const out=process.env.PAUI027_OUT;
 if(baseline){if(out)for(const width of [1366,1440,1920,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(out,'before-overview-'+width+'.png')});}console.log('PASS anonymous baseline capture');return;}
 await page.locator('.request-original').first().waitFor();assert.equal(await page.locator('.request-original').nth(1).textContent(),request);
 assert((await page.locator('#detail-card').innerText()).includes('何への回答かはこの索引では未提供'));
 assert.equal(await page.locator('.internal-history').evaluate(n=>n.open),false);
 const headings=await page.locator('#detail-card h2').allTextContents();assert.deepEqual(headings.slice(0,4).map(s=>s.trim().split(' ')[0]),['イベント基本情報','お客様からの依頼内容','問い合わせ添付資料','現在の案件状態']);
 assert.equal(await page.locator('#inquiry-attachment-grid .material-card').count(),2);
 const weights={};for(const [label,selector,weight]of [['body','.request-original',400],['facts','.fact b',400],['tab','.tab',500],['section','.sectiontitle',600],['title','#title',600]]){weights[label]=await page.locator(selector).first().evaluate(n=>Number(getComputedStyle(n).fontWeight));assert.equal(weights[label],weight);}
 for(const width of [1366,1440,1920,760,390]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('.request-original').nth(1).evaluate(n=>n.scrollWidth<=n.clientWidth));if(out&&width!==760)await page.screenshot({path:path.join(out,'after-overview-'+width+'.png')});}
 await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.locator('#formal-document-grid .material-card').first().waitFor();
 const formal=page.locator('#formal-document-grid .material-card').filter({hasText:'架空3ページ'});assert((await formal.innerText()).includes('契約正本：未確認'));
 await formal.locator('.material-thumb').click();await page.getByText('1 / 3ページ · 100%',{exact:true}).waitFor();await page.getByRole('button',{name:'次のページ',exact:true}).click();await page.getByText('2 / 3ページ · 100%',{exact:true}).waitFor();await page.getByRole('button',{name:'次のページ',exact:true}).click();await page.getByText('3 / 3ページ · 100%',{exact:true}).waitFor();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 assert((await page.locator('#current-estimate-grid').innerText()).includes('第3版'));assert.equal(await page.locator('#current-estimate-grid .material-card').count(),1);assert.equal(await page.locator('.estimate-history').evaluate(n=>n.open),false);assert.equal(await page.locator('.formal-history').evaluate(n=>n.open),false);
 if(out)await page.screenshot({path:path.join(out,'after-estimate-1440.png')});
 await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.locator('#material-grid .warehouse-meta').first().waitFor();assert.equal(await page.locator('#material-kind').inputValue(),'');assert.equal(await page.locator('#material-source').inputValue(),'');assert.equal(await page.locator('#material-grid .material-card').count(),items.length);
 const zip=page.locator('#material-grid .material-card').filter({hasText:'その他.zip'});assert.equal(await zip.count(),1);
 await page.locator('#material-kind').selectOption('見積書');await page.locator('#material-source').selectOption('commercial');assert.equal(await page.locator('#material-grid .material-card').count(),3);
 await page.locator('#material-search').fill('第2版');assert.equal(await page.locator('#material-grid .material-card').count(),1);
 await page.locator('#material-search').fill('');await page.locator('#material-kind').selectOption('');await page.locator('#material-source').selectOption('');
 const denied=page.locator('#material-grid .material-card').filter({hasText:'原本取得拒否.pdf'});await denied.locator('.material-thumb').scrollIntoViewIfNeeded();await denied.getByText('対応不明 / メールの添付索引との紐付けを検証できません',{exact:true}).waitFor();
 const photo=page.locator('#material-grid .material-card').filter({hasText:'会場写真.png'});await photo.locator('.material-thumb').click();await page.locator('dialog img').waitFor();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 for(const width of [1366,1440,1920,390]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(out)await page.screenshot({path:path.join(out,'after-warehouse-'+width+'.png')});}
 await page.locator('[data-case="'+B+'"]').click();await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.getByText('現在版未指定',{exact:true}).first().waitFor();assert.equal(await page.locator('#material-grid .material-thumb:disabled').count(),2);assert(!(await page.locator('#detail-card').innerText()).includes('架空3ページ'));
 deny=true;await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.getByText('403 / 認証・ACL未解決',{exact:false}).waitFor();assert((await page.locator('#file-count').innerText()).includes('一部未取得'));assert.equal(await page.locator('dialog').count(),0);
 assert.deepEqual(errors,[]);assert(calls.every(c=>c.method==='GET'));assert(!calls.some(c=>/sync|issue|send_reply|contract-pdf|token/.test(c.path)&&!c.path.endsWith('/tokens')));
 console.log(JSON.stringify({result:'PASS',items:items.length,weights,widths:[1366,1440,1920,760,390],formalPdfPages:3,identityDedup:true,versions:3,acl403:true,caseSwitch:true,methods:'GET only',pageErrors:0}));
 // Verify the deployed fixture never calls authenticated APIs.
 const preview=await browser.newPage(),apis=[];await preview.route('**/api/**',r=>{apis.push(r.request().url());return r.abort();});await preview.goto('http://127.0.0.1:'+server.address().port+'/tests/paui027-preview.html');await preview.locator('[data-case="'+A+'"]').click();await preview.locator('.request-original').first().waitFor();assert.deepEqual(apis,[]);await preview.close();
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
