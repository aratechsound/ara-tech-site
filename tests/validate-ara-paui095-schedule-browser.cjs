const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const {buildCustomerHtml} = require('../api/_pa-mail.cjs');

const root = path.resolve(__dirname,'..');
const fixtureId = '11111111-1111-4111-8111-111111111111';
const initialVersion = '2026-11-18T00:00:00.123456Z';
const issuedVersion = '2026-11-18T00:00:01.234567Z';
const tokenId = '22222222-2222-4222-8222-222222222222';
const inquiry = {
  id:fixtureId, inquiry_number:'PA-FIXTURE-A', case_type:'PA_EVENT', status:'schedule_coordination',
  event_name:'架空の日程調整案件', event_date:'2027-01-01', venue:'架空の会場',
  customer_name:'架空のお客様', email:'schedule@example.invalid',
  public_conditions:'架空の公開用条件', updated_at:initialVersion
};

async function main() {
  let history = [], deliveryHistory = [], responded = false, showDelivery = false;
  const calls = [], mailCalls = [];
  const errors = [];
  const blockedWrites = [];
  const server = http.createServer((req,res)=>{
    const url = new URL(req.url,'http://127.0.0.1');
    if (url.pathname === '/fixture-workspace' && req.method === 'GET') {
      const route = url.searchParams.get('path');
      let result = [];
      if (route === '/data/cases') result = {cases:[inquiry],progress:[{inquiry_id:fixtureId,is_on_hold:false}]};
      else if (route === '/data/case/'+fixtureId+'/tokens') result = history;
      else if (route === '/data/case/'+fixtureId+'/responses' && responded) result = [{decision:'agree'}];
      else if (route === '/data/case/'+fixtureId+'/deliveries' && showDelivery) result = deliveryHistory;
      else if (route.startsWith('/data/commercial/')) result = {estimates:[],offers:[],billings:[]};
      else if (route.startsWith('/data/materials/')) result = {cards:[],photos:[]};
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({ok:true,result}));
    }
    if (url.pathname.startsWith('/api/') || req.method !== 'GET') {
      blockedWrites.push({path:url.pathname,method:req.method});
      return res.writeHead(404).end();
    }
    const file = path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return res.writeHead(404).end();
    const type = {'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css'}[path.extname(file)];
    res.setHeader('Content-Type',type||'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch(process.env.PAUI021_BROWSER ? {executablePath:process.env.PAUI021_BROWSER} : {});
    const context = await browser.newContext({timezoneId:'UTC',viewport:{width:1440,height:900}});
    await context.route('**/*', route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.route(origin+'/pa-ui/js/integration.mjs',route=>route.fulfill({
      contentType:'text/javascript',body:
        "const session={user:{id:'fixture-owner'},access_token:'fixture-only',expires_at:9999999999};"
        + "export const workspaceAuth={restore:async()=>session,current:async()=>session};"
        + "export const readUrl=p=>'/fixture-workspace?path='+encodeURIComponent(p);"
        + "export const legacyUrl=id=>\"/pa-admin-legacy.html?case=\"+encodeURIComponent(id); export const requestScheduleToken=payload=>window.fixtureSchedule(payload);"
    }));
    await context.route(origin+'/api/pa-mail',async route=>{
      const input=route.request().postDataJSON();
      assert.equal(route.request().method(),'POST');
      assert.equal(input.inquiry_id,fixtureId);
      assert.equal(input.expected_recipient,inquiry.email);
      mailCalls.push(input);
      if(input.action==='preview_schedule')return route.fulfill({json:{ok:true,html:buildCustomerHtml(input.body)}});
      const prior=deliveryHistory.find(row=>row.id===input.delivery_id);
      if(['preview_schedule_retry','retry'].includes(input.action)){
        assert(prior);
        const snapshot=createHash('sha256').update(JSON.stringify([
          prior.inquiry_id,prior.id,prior.message_type,prior.attempt_number,prior.recipient,prior.subject,prior.body
        ])).digest('hex');
        assert.equal(input.expected_snapshot,snapshot);
        if(input.action==='preview_schedule_retry'){
          return route.fulfill({json:{ok:true,html:buildCustomerHtml(prior.body),delivery_snapshot:snapshot}});
        }
      }
      assert(['send_schedule','send_result','retry'].includes(input.action));
      const sent=input.action==='send_schedule';
      const status=sent?'sent':prior?'unknown':'failed';
      const delivery={id:sent?'fixture-sent':prior?'fixture-unknown':'fixture-failed',inquiry_id:fixtureId,
        message_type:sent?'schedule_request':'schedule_result_confirmed',attempt_number:prior?2:1,
        retry_of:prior?.id||null,error_summary:sent?null:prior?'mail_outcome_unknown':'gmail_oauth_503',
        status,gmail_message_id:sent?'fake_gmail_sent':null,recipient:inquiry.email,
        subject:prior?.subject||input.subject,body:prior?.body||input.body,requested_at:issuedVersion,sent_at:sent?issuedVersion:null};
      deliveryHistory.push(delivery);
      return route.fulfill({json:{ok:sent,delivery}});
    });
    const page = await context.newPage();
    page.on('pageerror', error=>errors.push(error.message));
    await page.exposeFunction('fixtureSchedule', async input=>{
      calls.push(input);
      if (input.action === 'issue') {
        const row = {id:tokenId, issued_at:issuedVersion, expires_at:input.expiry, revoked_at:null, answered_at:null};
        history = [row];
        Object.assign(inquiry, {updated_at:issuedVersion,status:'second_form_issued'});
        return {state:'issued',token_id:row.id,issued_at:row.issued_at,expires_at:row.expires_at,
          updated_at:issuedVersion,case_status:inquiry.status};
      }
      return {state:'stale'};
    });
    const openCase = origin+'/pa-admin.html?case='+fixtureId;
    await page.goto(openCase);
    const schedule = page.locator('#open-schedule');
    await schedule.click();
    const action = page.getByRole('button',{name:'リンク発行・失効',exact:true});
    await action.click();
    const dialog = page.getByRole('dialog',{name:'日程URLの発行・失効'});
    const issue = dialog.getByRole('button',{name:'日程URLを発行'});
    assert.equal(await dialog.getByRole('button',{name:'確認したURLを失効'}).count(),0);
    await issue.click();
    await dialog.getByText('現在より後の回答期限を日本時間で入力してください。').waitFor();
    assert.equal(calls.length,0);
    const expiry = new Date(Date.now()+7*86400000+9*3600000).toISOString().slice(0,16);
    await dialog.getByLabel('発行するURLの回答期限（JST）').fill(expiry);
    await issue.click();
    await dialog.getByText(/発行しました。/).waitFor();
    assert.equal(calls.length,1);
    const [issued] = calls;
    assert.equal(issued.action,'issue');
    assert.equal(issued.ownerId,'fixture-owner');
    assert.equal(issued.caseId,fixtureId);
    assert.equal(issued.updatedAt,initialVersion);
    assert.equal(issued.expectedToken,null);
    assert.equal(issued.expiry,new Date(expiry+':00+09:00').toISOString());
    assert.match(issued.token,/^[a-zA-Z0-9_-]{43}$/);
    assert.equal(await dialog.getByLabel('今回発行したURL').inputValue(),
      'https://ara-tech.cc/pa-schedule-confirm.html?token='+issued.token);
    assert(await issue.isDisabled());
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.locator('#schedule-issued-url').count(),0);

    await action.click();
    await dialog.getByRole('button',{name:'確認したURLを失効'}).click();
    await dialog.getByText(/発行・失効を確定できません/).waitFor();
    assert.equal(calls.length,2);
    assert.deepEqual(calls[1],{ownerId:'fixture-owner',caseId:fixtureId,updatedAt:issuedVersion,
      expectedToken:tokenId,action:'revoke',token:null,expiry:null});
    assert(await dialog.getByRole('button',{name:'確認したURLを失効'}).isDisabled());
    assert.equal(context.pages().length,1);
    assert.equal(new URL(page.url()).pathname,'/pa-admin.html');

    await page.keyboard.press('Escape');
    const invitation = page.getByRole('button',{name:'日程案内を作成'});
    await invitation.click();
    const composer = page.getByRole('dialog',{name:'日程案内メール'});
    assert.equal(await composer.getByLabel('宛先',{exact:true}).inputValue(),inquiry.email);
    assert.equal(await composer.getByLabel('宛先',{exact:true}).getAttribute('readonly'),'');
    await composer.getByRole('button',{name:'プレビュー'}).click();
    const review = composer.locator('[data-intake-review]');
    await review.waitFor();
    assert.equal(await review.locator('iframe').getAttribute('sandbox'),'');
    assert.match(await review.locator('iframe').getAttribute('srcdoc'),/ARA-TECH/);
    assert.deepEqual(mailCalls.map(entry=>entry.action),['preview_schedule']);
    await composer.getByRole('checkbox').check();
    await composer.getByLabel('件名',{exact:true}).fill('日程について／PA-FIXTURE-A');
    assert.equal(await review.isVisible(),false);
    await composer.getByRole('button',{name:'プレビュー'}).click();
    await review.waitFor();
    await composer.getByRole('checkbox').check();
    await composer.getByRole('button',{name:'確認した内容で送信する'}).click();
    await composer.waitFor({state:'hidden'});
    await page.getByText('送信は完了しました。配送履歴を再取得してください。').waitFor();
    assert.deepEqual(mailCalls.map(entry=>entry.action),['preview_schedule','preview_schedule','send_schedule']);
    assert.equal(mailCalls[2].schedule_url,'https://ara-tech.cc/pa-schedule-confirm.html?token='+issued.token);
    assert.match(mailCalls[2].operation_key,/^[a-f0-9-]{36}$/u);
    showDelivery=true;
    await page.getByRole('button',{name:'配送履歴を再取得'}).click();
    await page.getByText('送信しました。配送履歴を更新しました。').waitFor();
    assert.equal(mailCalls.length,3);

    await page.setViewportSize({width:390,height:844});
    responded=true;
    inquiry.status='schedule_adjusting';
    await page.goto(openCase);
    await schedule.click();
    await page.getByRole('button',{name:'日程確定を通知'}).click();
    const result = page.getByRole('dialog',{name:'日程確定を通知'});
    assert(await result.evaluate(node=>node.getBoundingClientRect().width<=innerWidth));
    await result.getByRole('button',{name:'プレビュー'}).click();
    await result.getByRole('checkbox').check();
    await result.getByRole('button',{name:'確認した内容で送信する'}).click();
    await result.getByText('送信に失敗しました。配送履歴を確認してください。').waitFor();
    await result.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'このメールを再送',exact:true}).click();
    const resend=page.getByRole('dialog',{name:'日程メールを再送'});
    assert.equal(await resend.getByRole('textbox',{name:'宛先',exact:true}).getAttribute('readonly'),'');
    assert.equal(await resend.getByRole('textbox',{name:'件名',exact:true}).getAttribute('readonly'),'');
    assert.equal(await resend.getByRole('textbox',{name:'本文',exact:true}).getAttribute('readonly'),'');
    await resend.getByRole('button',{name:'プレビュー'}).click();
    await resend.getByRole('checkbox').waitFor();
    assert.deepEqual(mailCalls.slice(3).map(entry=>entry.action),[
      'preview_schedule','send_result','preview_schedule_retry'
    ]);
    await resend.getByText(/重複して届きます/).waitFor();
    await resend.getByRole('checkbox',{name:/二重送信の可能性/}).check();
    await resend.getByRole('button',{name:'確認した内容で再送する'}).click();
    await resend.getByText('送信結果を確認できません。配送記録を確認してください。').waitFor();
    assert.equal(mailCalls.at(-1).action,'retry');
    assert.equal(mailCalls.at(-1).acknowledge_resend,true);
    assert.equal(mailCalls.at(-1).delivery_id,'fixture-failed');
    assert.equal(mailCalls.at(-1).subject,undefined);
    await resend.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.goto(openCase);
    await schedule.click();
    await page.getByText(/配送結果未確定/).waitFor();
    assert(await page.getByRole('button',{name:'日程確定を通知'}).isDisabled());
    assert(await page.getByRole('button',{name:'日程確保不可を通知'}).isDisabled());
    assert.equal(await page.getByRole('button',{name:'このメールを再送',exact:true}).count(),0);
    assert.equal(context.pages().length,1);
    assert.equal(new URL(page.url()).pathname,'/pa-admin.html');

    await page.goto(openCase+'&mail-view=readonly');
    await schedule.click();
    await page.getByRole('heading',{name:'日程案内・確定通知'}).waitFor();
    assert(await action.isDisabled());
    assert.equal(calls.length,2);
    assert.equal(mailCalls.length,7);
    assert(await page.getByRole('button',{name:'日程案内を作成'}).isDisabled());
    assert.deepEqual(blockedWrites,[]);
    assert.deepEqual(errors,[]);
    console.log('PASS isolated CASE DESK schedule links: issue in current view, exact version and token sent for revoke, stale result stops, sandboxed invitation and result, read-only readback, exact confirmed retry, UNKNOWN survives reload, no live traffic');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
