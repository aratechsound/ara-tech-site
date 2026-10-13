'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{const name=path.join(root,new URL(req.url,'http://localhost').pathname);if(!name.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(name));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
 const origin=process.env.PAUI024_PREVIEW||'http://127.0.0.1:'+server.address().port;
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],counts={},methods=[];let active=0,maxActive=0;
 page.on('pageerror',e=>errors.push(e.message));
 const C='11111111-1111-4111-8111-111111111111';
 const source='お世話になっております。\nARA-TECHの荒殿です。\nご連絡ありがとうございます。\n今回は11万円のご予算に合わせ、\n音響のみの構成をご提案しました。\n11月1日、2台、雨天中止の条件です。\n続きの原文です。\n--\n署名\n> 古いメール本文';
 await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only'}),current:async()=>({access_token:'fixture-only'}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;"}));
 await page.route('**/api/pa-workspace-read?**',async r=>{
 const p=new URL(r.request().url()).searchParams.get('path');methods.push(r.request().method());let value=[];
 if(p==='/data/cases')value={cases:[{id:C,event_name:'第8回広島都市学園大学みやこ祭',status:'new',case_type:'PA_EVENT',event_date:'2026-11-01'}],progress:[]};
 else if(p.startsWith('/data/commercial/'))value={estimates:[],offers:[],documents:[],billings:[]};
 else if(p.startsWith('/data/materials/'))value={cards:[],photos:[]};
 else if(p==='/data/mail/'+C)value=[{gmail_message_id:'purpose',inquiry_id:C,direction:'inbound',subject:'用件抜粋・架空検証',snippet:'お世話になっております。',attachment_metadata:[]},{gmail_message_id:'html',inquiry_id:C,direction:'outbound',subject:'HTML本文・架空検証',attachment_metadata:[]}];
 else if(p.startsWith('/data/mail-body/')){const id=p.split('/').pop();counts[id]=(counts[id]||0)+1;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,250));active--;value={gmail_message_id:id,inquiry_id:C,...(id==='html'?{body_html:'<p>Hello!</p><p>Thank you for your email.</p><p>Budget JPY 110,000; 2 units on 2026/11/01.</p><img src="https://invalid.example/tracker"><script>window.paui024Danger=true</script><blockquote>Old budget</blockquote>'}:{body_text:source})};}
 await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:value})});
 });
 await page.goto(origin+'/pa-admin.html');await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();
 const card=page.locator('[data-message="purpose"]'),body=card.locator('.mail-excerpt');
 await page.waitForFunction(()=>document.querySelector('[data-message="purpose"] .mail-excerpt').textContent.startsWith('今回は11万円'));
 assert.equal(await body.textContent(),'今回は11万円のご予算に合わせ、\n音響のみの構成をご提案しました。\n11月1日、2台、雨天中止の条件です。');assert.equal(counts.purpose,1);assert(maxActive<=2);
 await page.waitForFunction(()=>document.querySelector('[data-message="html"] .mail-excerpt').textContent.includes('Budget JPY 110,000'));
 assert.equal(await page.locator('[data-message="html"] .mail-excerpt').textContent(),'Budget JPY 110,000; 2 units on 2026/11/01.');assert.equal(await page.evaluate(()=>window.paui024Danger),undefined);assert.equal(await page.locator('.mail-row img,.mail-row script').count(),0);
 const bg=selector=>page.locator(selector).evaluate(n=>getComputedStyle(n).backgroundColor);
 assert.equal(await bg('.top'),'rgb(0, 123, 255)');assert.equal(await bg('.aside'),'rgb(9, 9, 9)');assert.equal(await bg('.central'),'rgb(0, 0, 0)');assert.equal(await bg('.inspector'),'rgb(17, 17, 17)');assert.equal(await bg('.mail-row.received'),'rgb(17, 17, 17)');
 assert.equal(await page.locator('.globalnav button.active').evaluate(n=>getComputedStyle(n).borderBottomColor),'rgb(255, 255, 255)');assert(await page.locator('.top .brand img').evaluate(n=>n.complete&&n.naturalWidth>0));
 const neutral=await page.locator('.shell *').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height&&!n.matches('.tiny,.pill,.bubble,.countdot,.newdot,.notice,.guard,.read-error,.sideaction,.schedule-hero')).map(n=>({selector:n.className,bg:getComputedStyle(n).backgroundColor,image:getComputedStyle(n).backgroundImage})).filter(v=>{const rgb=v.bg.match(/^rgb\((\d+), (\d+), (\d+)\)$/);return rgb&&(rgb[1]!==rgb[2]||rgb[2]!==rgb[3])||v.image!=='none';}));assert.deepEqual(neutral,[],'All workspace panel backgrounds must be neutral');
 const before={...counts};for(let i=0;i<2;i++){await card.getByRole('button',{name:'全文を表示',exact:true}).click();assert((await body.textContent()).startsWith('お世話になっております。'));assert((await body.textContent()).includes('続きの原文です。'));assert(!await body.evaluate(n=>/auto|scroll/.test(getComputedStyle(n).overflowY)));await card.locator('[data-quoted-body] summary').click();assert(await card.locator('[data-quoted-body]').evaluate(n=>n.open));await card.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await card.locator('[data-quoted-body]').evaluate(n=>n.open),false);}assert.deepEqual(counts,before);
 if(process.env.PAUI024_SCREENSHOT)await page.screenshot({path:process.env.PAUI024_SCREENSHOT});
 for(const width of [760,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'small screen horizontal fit');assert.equal(await bg('.top'),'rgb(0, 123, 255)');await card.getByRole('button',{name:'全文を表示',exact:true}).click();assert.equal(await body.evaluate(n=>getComputedStyle(n).overflowY),'visible');await card.getByRole('button',{name:'閉じる',exact:true}).click();}
 if(process.env.PAUI024_SMALL_SCREENSHOT)await page.screenshot({path:process.env.PAUI024_SMALL_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);assert(methods.every(m=>m==='GET'));console.log('PASS brand black 1440x900/760/390: white logo, neutral panels, HTML inert, snippet refresh, original excerpt, full/reopen/quote, no inner scroll, toggle GET=0');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
