'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),baseline=process.env.PAUI026_BASELINE==='1';
(async()=>{
 const server=http.createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
 const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],methods=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
 const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',V='33333333-3333-4333-8333-333333333333';
 const filename='架空検証用の長い見積書ファイル名_原本と送信日時は別の記録です_'.repeat(4)+'.pdf';
 let deny=false;
 await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only'}),current:async()=>({access_token:'fixture-only'}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;"}));
 await page.route('**/api/pa-workspace-read?**',r=>{
 const p=new URL(r.request().url()).searchParams.get('path');methods.push(r.request().method());let value=[];
 if(p==='/data/cases')value={cases:[{id:A,event_name:'架空検証A',status:'schedule_confirmed',case_type:'PA_EVENT'},{id:B,event_name:'架空検証B',status:'new',case_type:'PA_EVENT'}],progress:[{inquiry_id:A,current_step:2,formal_contract_id:V}]};
 else if(p.startsWith('/data/commercial/')){if(deny)return r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,code:'read_denied'})});value={estimates:[],offers:[],documents:[],billings:[],read_projection:true};}
 else if(p.endsWith('/audit'))value=[{action:'gmail_threads_synced',occurred_at:'2026-10-01T00:00:00Z'},{action:'unrecognized_event',occurred_at:'2026-10-01T00:00:00Z'}];
 else if(p.endsWith('/deliveries')){if(deny)return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'unavailable'})});value=p.includes(A)?[{id:V,inquiry_id:A,status:'unknown',message_type:'schedule',requested_at:'2026-10-01T00:00:00Z'}]:[];}
 else if(p.startsWith('/data/materials/'))value={cards:[{id:'missing',title:'版指定あり・取得不能',current_version_id:V,versions:[]},{id:'empty',title:'版指定なし',current_version_id:null,versions:[]},{id:'indexed',title:'紐付け不明の原本',current_version_id:V,owner_kind:'shared',versions:[{id:V,source_type:'gmail_attachment',display_filename:'fixture.pdf',mime_type:'application/pdf',version_label:'v2'}]}],photos:[]};
 else if(p.startsWith('/data/material/'))return r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,code:'attachment_mail_mismatch'})});
 else if(p.startsWith('/data/sent-estimates/'))value={messages:Array.from({length:3},(_,i)=>({gmail_message_id:'sent'+i,inquiry_id:A,direction:'outbound',subject:'架空の長いメール件名'.repeat(12),sent_at:'2026-10-01T00:00:00Z',attachment_metadata:[{id:'part'+i,filename,mime_type:'application/pdf'}]})),unknown:[]};
 else if(p.startsWith('/data/sent-estimate-attachment/'))return r.fulfill({status:404,contentType:'application/json',body:JSON.stringify({ok:false,code:'not_found'})});
 r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:value})});
 });
 await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();
 if(baseline)await page.getByText('gmail_threads_synced',{exact:true}).first().waitFor();
 if(!baseline){
 await page.getByText('Gmailのやり取りを同期',{exact:true}).waitFor();
 await page.locator('.legacy-workflow summary').click();
 const text=await page.locator('#detail-card').innerText();assert(text.includes('旧14工程'));assert(text.includes('契約成立・入金・案件完了の証明ではありません'));
 assert(text.includes('正式受注済'));assert.equal(await page.locator('.workflow .done').count(),0);
 assert((await page.locator('#inspector').innerText()).includes('この案件の配送UNKNOWN: 1件'));
 await page.getByRole('button',{name:'履歴',exact:true}).click();assert((await page.locator('#detail-card').innerText()).includes('監査識別子: gmail_threads_synced'));assert((await page.locator('#detail-card').innerText()).includes('業務履歴（種別未定義）'));
 }
 await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.locator('#sent-estimate-grid .material-card').first().waitFor();
 const metrics=[];
 for(const width of [1366,1440,1920,390]){
 await page.setViewportSize({width,height:900});
 const m=await page.locator('#sent-estimate-grid').evaluate(n=>({grid:n.getBoundingClientRect().width,cards:[...n.children].map(c=>({width:c.getBoundingClientRect().width,nameHeight:c.querySelector('.material-name').getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(c.querySelector('.material-name')).lineHeight),overflow:c.scrollWidth>c.clientWidth})),pageFit:document.documentElement.scrollWidth<=innerWidth}));metrics.push({width,...m});
 if(!baseline){assert(m.pageFit);assert(m.cards.every(c=>c.width>=Math.min(230,m.grid)-2&&!c.overflow&&c.nameHeight<=c.lineHeight*3+1),JSON.stringify(m));}
 if(process.env.PAUI026_OUT){await page.locator('#sent-estimate-grid').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.PAUI026_OUT,(baseline?'before-':'after-')+width+'.png'),fullPage:width===390});}
 }
 if(baseline){console.log(JSON.stringify({mode:'BASELINE',metrics,inspector:await page.locator('#inspector').innerText()}));return;}
 await page.locator('#sent-estimate-grid details').first().locator('summary').click();assert((await page.locator('#sent-estimate-grid details').first().innerText()).includes(filename));
 assert((await page.locator('#detail-card').innerText()).includes('取得できた正式確認の発行記録は0件'));
 assert((await page.locator('#detail-card').innerText()).includes('同意・契約成立記録の不存在を意味しません'));
 await page.setViewportSize({width:1440,height:900});await page.locator('[data-tab="documents"]').click();await page.getByText('対応不明 / メールの添付索引との紐付けを検証できません',{exact:true}).waitFor();
 assert((await page.locator('#material-grid').innerText()).includes('現在版の索引未取得'));
 assert((await page.locator('#material-grid').innerText()).includes('現在版未指定'));
 const disabled=page.locator('#material-grid .material-thumb:disabled');assert.equal(await disabled.count(),2);
 await page.locator('[data-case="'+B+'"]').click();await page.locator('.case-delivery').getByText('取得した配送記録にUNKNOWNはありません',{exact:false}).waitFor();assert(!(await page.locator('#inspector').innerText()).includes('この案件の配送UNKNOWN: 1件'));
 deny=true;await page.locator('[data-case="'+A+'"]').click();await page.locator('.case-delivery').getByText('この案件の配送記録を取得できません',{exact:false}).waitFor();await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.getByText('403 / 認証・ACL未解決',{exact:false}).first().waitFor();assert(!(await page.locator('#detail-card').innerText()).includes('取得できた正式確認の発行記録は0件'));
 assert.deepEqual(errors,[]);assert(methods.every(m=>m==='GET'));console.log(JSON.stringify({mode:'CANDIDATE_PASS',metrics,caseSwitch:true,unavailableNotEmpty:true,methods:'GET only'}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
