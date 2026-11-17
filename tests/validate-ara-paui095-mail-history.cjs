const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {createReadHandler} = require('../api/_pa-workspace-read.cjs');
const {buildCustomerHtml} = require('../api/_pa-mail.cjs');

const root = path.resolve(__dirname, '..');
const caseId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const token = 'Bearer fixture-owner-read-token-0000';
const body = 'お見積りを送付します。\n次の段落です。\n\n合計110,000円です。';
const expected = buildCustomerHtml(body);
const original = expected.replace('</body>', `
  <p><a href="https://external.invalid/link">閲覧用URL</a></p>
  <img src="https://external.invalid/pixel">
  <img src="https://ara-tech.cc/img/ara-tech-logo-horizontal-white.png?t=tracking">
  <p style="background-image:url(https://external.invalid/background)">原本の追記</p>
  <script>window.mailFixtureRan = true</script>
  <iframe src="https://external.invalid/frame"></iframe></body>`);
const record = {
  id:deliveryId,inquiry_id:caseId,status:'sent',message_type:'content_hearing_follow_up',body,
  subject:'初回返信',recipient:'customer@example.invalid',gmail_message_id:'delivery_only',sent_at:'2026-11-14T03:00:00Z'
};
const json = result => ({ok:true,result});
const upstream = [];
let deliveryMode;
const read = createReadHandler({
  key:'sb_publishable_fixture',
  provider:{},
  fetchImpl:async (value,options) => {
    const url = new URL(value);
    assert.equal(options.method,'GET');
    assert.equal(options.headers.authorization,token);
    const table = url.pathname.split('/').at(-1);
    upstream.push(table);
    let result = [];
    if (table==='user') result = {id:caseId};
    if (table==='work_admins') result = [{user_id:caseId}];
    if (table==='pa_inquiries'&&url.searchParams.get('id')==='eq.'+caseId) result = [{id:caseId}];
    if (table==='pa_email_deliveries') {
      assert.equal(url.searchParams.get('id'),'eq.'+deliveryId);
      assert.equal(url.searchParams.get('inquiry_id'),'eq.'+caseId);
      assert.equal(url.searchParams.get('status'),'eq.sent');
      result = [deliveryMode==='foreign'?{...record,inquiry_id:otherId}:
        deliveryMode==='failed'?{...record,status:'failed'}:
        deliveryMode==='unknown'?{...record,error_summary:'send_outcome_unknown'}:
        deliveryMode==='internal'?{...record,message_type:'internal_new_inquiry'}:record];
    }
    return Response.json(result);
  }
});

const workspace = target => '/api/pa-workspace-read?path=' + encodeURIComponent(target);
async function main() {
  const errors = [], remoteRequests = [], browserWrites = [], requests = [], localImages = [];
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    if (url.pathname==='/api/pa-workspace-read') {
      const route = url.searchParams.get('path');
      requests.push({route,method:req.method});
      if (route.startsWith('/data/mail-delivery-html/')) return read(req,res);
      let result = [];
      if (route==='/data/cases') result = {
        cases:[{id:caseId,inquiry_number:'PA-FIXTURE-A',status:'new_inquiry',submission_source:'public_form'}],progress:[]
      };
      if (route==='/data/commercial/'+caseId) result = {estimates:[],offers:[],billings:[]};
      if (route==='/data/case/'+caseId+'/deliveries') result = [record];
      if (route==='/data/mail/'+caseId) result = [
        {inquiry_id:caseId,gmail_message_id:'provider_original',direction:'outbound',subject:'Gmail送信履歴',body_text:body},
        {inquiry_id:caseId,gmail_message_id:'customer_inbound',direction:'inbound',subject:'顧客返信',body_text:'顧客側の本文'}
      ];
      if (route==='/data/mail-body/'+caseId+'/provider_original') result = {
        inquiry_id:caseId,gmail_message_id:'provider_original',body_text:body,body_html:original,source:'gmail'
      };
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify(json(result)));
    }
    const file = path.resolve(root,'.'+url.pathname);
    if (!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) {
      res.writeHead(404);return res.end();
    }
    const type = {'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'}[path.extname(file)];
    res.setHeader('Content-Type',type||'application/octet-stream');
    if (url.pathname==='/pa-admin.html') {
      const config = JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));
      const rules = config.headers.find(rule=>rule.source==='/pa-admin.html').headers;
      res.setHeader('Content-Security-Policy',rules.find(header=>header.key==='Content-Security-Policy').value);
    }
    if (url.pathname.startsWith('/img/')) localImages.push(url.pathname+url.search);
    return res.end(fs.readFileSync(file));
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch();
    const page = await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      const request = route.request(), url = new URL(request.url());
      if (url.origin===origin) {
        if (url.pathname.startsWith('/api/')&&request.method()!=='GET') {
          browserWrites.push(url.pathname);return route.abort();
        }
        return route.continue();
      }
      remoteRequests.push(route.request().url());return route.abort();
    });
    await page.route('**/pa-ui/js/integration.mjs',route=>route.fulfill({contentType:'text/javascript',body:`
      const session={access_token:${JSON.stringify(token.slice(7))},user:{id:'owner'},expires_at:9999999999};
      export const workspaceAuth={restore:async()=>session,current:async()=>session};
      export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);
      export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;`}));
    const route = '/data/mail-delivery-html/'+caseId+'/'+deliveryId;
    const httpRead = async (target,auth=token,method='GET') =>
      page.request.fetch(origin+workspace(target),{method,headers:{authorization:auth}});
    assert.equal((await httpRead(route,'')).status(),401);
    assert.equal((await httpRead(route,token,'POST')).status(),405);
    assert.equal((await httpRead(route.replace(caseId,otherId))).status(),403);
    for (deliveryMode of ['foreign','failed','unknown','internal']) assert.equal((await httpRead(route)).status(),404);
    deliveryMode = '';
    const valid = await httpRead(route);
    assert.equal(valid.status(),200);
    assert.equal((await valid.json()).result.body_html,expected);
    assert.equal(valid.headers()['cache-control'],'private, no-store');

    await page.goto(origin+'/pa-admin.html?case='+caseId+'&tab=conversation&mail-view=readonly');
    const button = page.getByRole('button',{name:'HTML本文を表示',exact:true});
    const dialog = page.getByRole('dialog',{name:'送信メールのHTML本文',exact:true});
    const frame = dialog.locator('iframe');
    const content = dialog.frameLocator('iframe');
    const open = async (selector,status) => {
      await page.locator(selector).getByRole('button',{name:'HTML本文を表示',exact:true}).click();
      await dialog.getByText(status,{exact:false}).waitFor();
      assert.equal(await frame.getAttribute('srcdoc'),null);
      assert.equal(await frame.isHidden(),true);
      const before = localImages.length;
      await dialog.getByRole('button',{name:'HTML本文・金額を表示',exact:true}).click();
      await content.getByText('お見積りを送付します。',{exact:false}).waitFor();
      assert.equal(await frame.getAttribute('sandbox'),'');
      assert.match(await frame.getAttribute('srcdoc'),/default-src 'none'/u);
      const qr = content.getByAltText('ARA-TECH公式LINE QRコード');
      await qr.waitFor();
      assert.equal(await qr.evaluate(image=>image.complete&&image.naturalWidth>0),true);
      assert.equal(await content.locator('img').count(),3);
      assert.equal(await content.locator('td').filter({has:content.getByAltText('ARA-TECH',{exact:true})}).count()>0,true);
      assert.equal(await content.locator('td[style*="rgb(0, 123, 255)"]').count()>0,true);
      assert.equal(await content.locator('a,script,form,iframe,[srcset]').count(),0);
      assert(!remoteRequests.some(url=>url.includes('external.invalid')));
      assert(localImages.slice(before).every(url=>!url.includes('?')));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
      assert.equal(await frame.getAttribute('srcdoc'),null);
      await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
      await dialog.waitFor({state:'detached'});
    };
    await button.first().waitFor();
    assert.equal(await page.locator('[data-message="customer_inbound"] [data-history-mail-html]').count(),0);
    await open('[data-delivery-id="'+deliveryId+'"]','共通テンプレートで再構成');
    await open('[data-message="provider_original"]','Gmail原本の書式');
    assert.deepEqual(errors,[]);
    assert.deepEqual(browserWrites,[]);
    assert(upstream.includes('pa_email_deliveries'));
    assert(requests.slice(requests.findLastIndex(call=>call.method==='POST')+1).every(call=>call.method==='GET'));
    console.log('PASS delivery and Gmail HTML history, common template, sandbox, amount reveal/reset, case ACL and no external mail resources');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
