const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname,'..');
const fixtureId = '11111111-1111-4111-8111-111111111111';
const initialVersion = '2026-11-18T00:00:00.123456Z';
const issuedVersion = '2026-11-18T00:00:01.234567Z';
const tokenId = '22222222-2222-4222-8222-222222222222';
const inquiry = {
  id:fixtureId, inquiry_number:'PA-FIXTURE-A', case_type:'PA_EVENT', status:'schedule_coordination',
  event_name:'架空の日程調整案件', event_date:'2027-01-01', venue:'架空の会場',
  public_conditions:'架空の公開用条件', updated_at:initialVersion
};

async function main() {
  let history = [];
  const calls = [];
  const errors = [];
  const blockedWrites = [];
  const server = http.createServer((req,res)=>{
    const url = new URL(req.url,'http://127.0.0.1');
    if (url.pathname === '/fixture-workspace' && req.method === 'GET') {
      const route = url.searchParams.get('path');
      let result = [];
      if (route === '/data/cases') result = {cases:[inquiry],progress:[{inquiry_id:fixtureId,is_on_hold:false}]};
      else if (route === '/data/case/'+fixtureId+'/tokens') result = history;
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
    const context = await browser.newContext({timezoneId:'UTC'});
    await context.route('**/*', route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.route(origin+'/pa-ui/js/integration.mjs',route=>route.fulfill({
      contentType:'text/javascript',body:
        "const session={user:{id:'fixture-owner'},access_token:'fixture-only',expires_at:9999999999};"
        + "export const workspaceAuth={restore:async()=>session,current:async()=>session};"
        + "export const readUrl=p=>'/fixture-workspace?path='+encodeURIComponent(p);"
        + "export const legacyUrl=id=>\"/pa-admin-legacy.html?case=\"+encodeURIComponent(id); export const requestScheduleToken=payload=>window.fixtureSchedule(payload);"
    }));
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

    await page.goto(openCase+'&mail-view=readonly');
    await schedule.click();
    await page.getByRole('heading',{name:'日程案内・確定通知'}).waitFor();
    assert(await action.isDisabled());
    assert.equal(calls.length,2);
    assert.deepEqual(blockedWrites,[]);
    assert.deepEqual(errors,[]);
    console.log('PASS isolated CASE DESK schedule links: issue in current view, exact version and token sent for revoke, stale result stops, read-only blocked, no live traffic');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
