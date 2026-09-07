const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),out=process.env.PA_CONTRACT_OUTPUT_DIR||path.join(root,'tmp','contract-v3-browser');fs.mkdirSync(out,{recursive:true});
const {createFixture}=require(path.join(root,'tests/helpers/pa-contract-fixture.cjs'));
const {sha}=require(path.join(root,'api/_pa-contract-pdf.cjs'));
const {replyPreview}=require(path.join(root,'api/_pa-gmail.cjs'));
const {terms}=require(path.join(root,'api/_pa-contract-terms.cjs'));
const read=p=>fs.readFileSync(path.join(root,p));
async function main(){
 const f=await createFixture();let server,browser,legacy=false;
 try{
  f.state.related=f.quote;
  await f.db.query("update pa_gmail_message_index set attachment_metadata=attachment_metadata || '[{\"id\":\"attachment_2\",\"filename\":\"layout.pdf\",\"mime_type\":\"application/pdf\"}]'::jsonb where gmail_message_id='direct_sent_001'");
  const related=await f.service.relatedSource(f.inquiryId,'direct_sent_001','attachment_2');
  const issued=(await f.call({action:'issue',case_id:f.inquiryId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_1',quote_sha256:sha(f.quote),customer_name:'安芸太田町 産業観光課 商工観光係　竹林 智也 様（表示検証用）',amount:170500,order_scope:{performance_time:'10:00〜15:00',venue:'温井ダム堤体横駐車場（検証用）',services:'音響機材・設営・PAオペレート・電源／発電機対応'},related_documents:[related.identity]})).body.result;
  const token=new URL(issued.url).hash.slice(1);
  const mailBody='竹林様\n\nお世話になっております。\nARA-TECHの荒殿です。\n\n2026年10月18日開催の「2026龍姫湖まつり」につきまして、正式受注確認の内容をご用意いたしました。\n\n下記URLより、最終見積書（税込170,500円）およびご依頼条件をご確認ください。\n\n【正式受注確認URL】\nhttps://ara-tech.cc/pa-contract.html#'+'a'.repeat(64)+'\n\n内容をご確認のうえ、確認ページ内の「この内容で正式に依頼する」ボタンからお手続きをお願いいたします。\n\nご不明な点や、支払条件などについてご相談がある場合は、正式依頼のお手続き前にこのメールへご返信ください。\n\nどうぞよろしくお願いいたします。\n\nARA-TECH\n荒殿 竜一';
  const preview=await replyPreview({inquiryId:f.inquiryId,actorId:f.actorId,body:mailBody},f.fetchImpl);
  const config=JSON.parse(read('vercel.json')),headersFor=p=>Object.fromEntries(config.headers.find(x=>x.source===p)?.headers.map(x=>[x.key,x.value])||[]);
  const adminHtml=read('pa-admin.html').toString(),previewMarkup=adminHtml.split('\n').find(l=>l.includes('id="gmail-reply-preview"'));
  const source=read('js/pa-admin.js').toString(),previewFunction=source.slice(source.indexOf('const previewGmailReply = async () => {'),source.indexOf('const isGmailReplySnapshotSelected ='));
  const mailScript=`const $=s=>document.querySelector(s);let currentCase={id:'${f.inquiryId}'},gmailReplyPreview,gmailReplyPreviewBinding,gmailReplyMode='normal',gmailReplyAttachments=[];const gmailReplyAttachmentPayload=async()=>[],callGmailApi=async()=>({preview:${JSON.stringify(preview)}}),renderGmailReplyPreviewAttachments=()=>{},setMessage=(el,s)=>el.textContent=s,gmailErrorMessage=s=>s;${previewFunction}\ndocument.querySelector('#preview-test').onclick=previewGmailReply;document.querySelector('#gmail-reply-body').value=${JSON.stringify(mailBody)};`;
  server=http.createServer(async(req,res)=>{
   try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/pa-contract'){
     let body='';for await(const part of req)body+=part;const input=JSON.parse(body);
     assert(['view','quote','related_document','list','inspect_quote','inspect_related','preview_conditions'].includes(input.action),'Browser test cannot accept or mutate');
     const r=await f.call(input,{admin:['list','inspect_quote','inspect_related','preview_conditions'].includes(input.action)});
     if(legacy&&input.action==='view'&&r.body.result.snapshot){const s=r.body.result.snapshot;Object.assign(s,terms(s.event_date));for(const k of ['presentation_version','payment_due_date','payment_summary','related_documents','cancellation_bands'])delete s[k];}
     res.writeHead(r.statusCode,{'Content-Type':r.bytes?'application/pdf':'application/json',...r.headers});res.end(r.bytes||JSON.stringify(r.body));return;
    }
    if(url.pathname==='/api/pa-gmail'){let body='';for await(const part of req)body+=part;assert.equal(JSON.parse(body).action,'attachment_download');res.writeHead(200,{'Content-Type':'application/pdf'});res.end(f.quote);return;}
    if(url.pathname==='/admin-test.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(`import {renderContractPanel} from '/js/pa-contract-admin.js';const item={id:'${f.inquiryId}',event_date:'2026-10-18',customer_name:'管理下テスト',request_summary:'テストPA'},context={case:item,progress:{estimate_amount:170500},gmailRef:[],getAccessToken:async()=>'fixture-admin',getCurrentCase:()=>item};renderContractPanel(context);document.querySelector('#simulate-gmail-sync').onclick=()=>{document.querySelector('[data-c="url"]').value='controlled-one-time-value';context.gmailRef=[];renderContractPanel(context);};`);return;}
    if(url.pathname==='/admin-test.html'){res.writeHead(200,{'Content-Type':'text/html',...headersFor('/pa-admin.html')});res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><link rel="stylesheet" href="/pa-admin.css"><script type="module" src="/admin-test.js"></script><main><button id="simulate-gmail-sync">同期完了を模擬</button><section id="formal-contract-panel"></section></main></html>');return;}
    if(url.pathname==='/mail-test.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(mailScript);return;}
    if(url.pathname==='/mail-test.html'){
     res.writeHead(200,{'Content-Type':'text/html',...headersFor('/pa-admin.html')});res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pa-admin.css"><script src="/mail-test.js" defer></script><body><main><textarea id="gmail-reply-body"></textarea><input id="gmail-reply-recipient"><input id="gmail-reply-subject"><button id="preview-test">メールをプレビュー</button><button id="send-gmail-reply" disabled>送信（テスト無効）</button><p id="gmail-reply-message"></p>'+previewMarkup+'</main></body></html>');return;
    }
    const p=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert(p.startsWith(root+path.sep));
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon'}[path.extname(p)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,...headersFor(url.pathname)});res.end(fs.readFileSync(p));
   }catch(e){res.writeHead(500);res.end('fixture_error');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context=await browser.newContext({deviceScaleFactor:1});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===base||u.protocol==='blob:')return route.continue();if(u.origin==='https://ara-tech.cc'&&u.pathname.startsWith('/img/'))return route.fulfill({body:read(decodeURIComponent(u.pathname).slice(1)),contentType:'image/png'});return route.abort();});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const results=[];
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});await page.goto(base+'/pa-contract.html#'+token);await page.locator('#confirmation').waitFor({state:'visible'});await page.locator('#pdfViewer').waitFor({state:'visible'});
   assert.equal(new URL(page.url()).hash,'');assert(!await page.locator('#agree').isChecked());assert.equal(await page.locator('.cancel-cell').count(),4);assert.equal(await page.getByRole('tab').count(),2);
   assert.match(await page.locator('#payment-date').innerText(),/2026年11月2日.*月/);assert(!/version|軽微な運用変更|契約上の主要条件/.test(await page.locator('body').innerText()));
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,content:document.querySelector('main').getBoundingClientRect().width,logo:document.querySelector('.brand img').naturalWidth,background:getComputedStyle(document.querySelector('.brand')).backgroundColor,terms:document.querySelector('#business').clientHeight,termsScroll:document.querySelector('#business').scrollHeight,submitDisabled:document.querySelector('#submit').disabled,pdfHeight:document.querySelector('#pdfViewer').clientHeight}));
   assert(geometry.scroll<=width);assert(geometry.logo>0);assert.equal(geometry.background,'rgb(0, 123, 255)');if(width===1440)assert(geometry.content>=1100&&geometry.content<=1150);assert(geometry.termsScroll>geometry.terms);assert(!geometry.submitDisabled);assert(geometry.pdfHeight>=350);
   assert(await page.locator('#order-scope').isVisible());assert.match(await page.locator('#scope-grid').innerText(),/10:00〜15:00/);assert.equal(await page.locator('#business h3').count(),6);
   assert(!/キャンセル条件|支払条件|外注費|いずれか高い方/.test(await page.locator('#business').innerText()));assert.equal(await page.getByRole('heading',{name:'その他のご確認事項',exact:true}).count(),1);
   assert.equal(await page.locator('#confirmer').getAttribute('readonly'),null);
   await page.waitForTimeout(1800);await page.screenshot({path:path.join(out,'contract-'+width+'.png'),fullPage:true});
   const firstSrc=await page.locator('#pdfViewer').getAttribute('src');await page.getByRole('tab').nth(1).click();await page.waitForFunction(s=>document.querySelector('#pdfViewer').src!==s&&!document.querySelector('#pdfViewer').hidden,firstSrc);
   assert.match(await page.locator('#docNote').innerText(),/金額根拠資料ではありません/);results.push(geometry);
  }
  legacy=true;await page.goto(base+'/pa-contract.html#'+token);await page.locator('#confirmation').waitFor({state:'visible'});assert.equal(await page.getByRole('tab').count(),1);assert.equal(await page.locator('.cancel-cell').count(),0);assert(!await page.locator('#payment-date').innerText().then(t=>t.includes('11月2日')));assert.equal(await page.locator('#legacy-cancel').innerText(),terms('2026-10-18').cancellation_terms);legacy=false;
  await page.goto(base+'/admin-test.html');await page.locator('[data-c="related"] input').first().waitFor({state:'attached'});
  await page.getByRole('button',{name:'正式受注確認を開始',exact:true}).click();
  assert.equal(await page.locator('[data-c="related"] input:checked').count(),0);assert(await page.locator('[data-c="issue"]').isDisabled());
  await page.locator('[data-c="scope-time"]').fill('10:00〜15:00');await page.locator('[data-c="scope-venue"]').fill('検証用会場');await page.locator('[data-c="scope-services"]').fill('管理下テストPA');
  await page.locator('[data-c="quotes"]').selectOption('0');
  await page.getByRole('button',{name:'選択したPDFを確認',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-c="identity"]').textContent.includes('SHA-256'));
  assert(await page.locator('[data-c="issue"]').isDisabled());await page.locator('[data-c="conditions"]').click();await page.waitForFunction(()=>document.querySelector('[data-c="conditions-preview"]').textContent.includes('2026-11-02'));assert(!await page.locator('[data-c="issue"]').isDisabled());
  const relatedCheck=page.locator('[data-c="related"] label').filter({hasText:'layout.pdf'}).first().locator('input');await relatedCheck.check();assert(await page.locator('[data-c="issue"]').isDisabled());await page.locator('[data-c="inspect-related"]').click();await page.waitForFunction(()=>document.querySelector('[data-c="related-status"]').textContent.includes('SHA-256'));assert(!await page.locator('[data-c="issue"]').isDisabled());
  await page.locator('[data-c="payment"]').fill('承認済み翌月末払');assert(await page.locator('[data-c="issue"]').isDisabled());await page.locator('[data-c="payment-date"]').fill('2026-11-30');await page.locator('[data-c="payment-approved"]').check();await page.locator('[data-c="conditions"]').click();await page.waitForFunction(()=>document.querySelector('[data-c="conditions-preview"]').textContent.includes('2026-11-30'));assert(!await page.locator('[data-c="issue"]').isDisabled());
  assert.equal(Number((await f.db.query('select count(*) n from pa_contract_offers')).rows[0].n),1);
  await page.getByRole('button',{name:'同期完了を模擬'}).click();await page.waitForFunction(()=>document.querySelector('[data-c="identity"]').textContent==='');assert.equal(await page.locator('[data-c="related"] input:checked').count(),0);assert(await page.locator('[data-c="issue"]').isDisabled());assert.equal(await page.locator('[data-c="url"]').inputValue(),'controlled-one-time-value');
  await page.goto(base+'/mail-test.html');await page.getByRole('button',{name:'メールをプレビュー'}).click();
  const frame=page.frameLocator('#gmail-reply-preview-frame');await frame.getByText('竹林様',{exact:false}).first().waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#gmail-reply-preview-frame').contentDocument?.querySelector('img')?.naturalWidth>0);
  const logo=await frame.locator('img').first().evaluate(el=>({width:el.naturalWidth,background:getComputedStyle(el.parentElement).backgroundColor}));assert(logo.width>0);assert.equal(logo.background,'rgb(0, 123, 255)');
  assert.equal(await page.locator('#gmail-reply-preview-frame').getAttribute('srcdoc'),preview.html);
  assert(await frame.locator('a[href^="https://lin.ee/"]').count()>0);assert(await frame.locator('a[href="https://ara-tech.cc"]').count()>0);
  assert(!await page.locator('#gmail-reply-preview details').getAttribute('open'));
  await page.screenshot({path:path.join(out,'mail-390.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'mail-desktop.png'),fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(f.state.sendCount,0);assert.equal(Number((await f.db.query('select count(*) n from pa_contracts')).rows[0].n),0);
  fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify({results,logo,errors,legacyUnchanged:true,liveEmailSent:false,customerAccepted:false},null,2));console.log(JSON.stringify({pass:true,results,logo,legacyUnchanged:true,liveEmailSent:false,customerAccepted:false}));
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
