const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
const first='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const unknown='33333333-3333-4333-8333-333333333333';
const cases=[
  {id:first,inquiry_number:'PA-FIXTURE-A',event_name:'開催希望の架空案件',event_date:'2026-12-02',status:'new_inquiry',case_type:'PA_EVENT'},
  {id:second,inquiry_number:'PA-FIXTURE-B',event_name:'確保済みの架空案件',event_date:'2026-12-02',status:'schedule_confirmed',case_type:'PA_EVENT'},
  {id:unknown,inquiry_number:'PA-FIXTURE-C',event_name:'日程未定の架空案件',status:'new_inquiry',case_type:'PA_EVENT'}
];
const progress=[{inquiry_id:second,confirmed_event_date:'2026-12-04'}];

async function main(){
  const {caseCalendar,jstDate}=await import('../pa-ui/js/case-calendar.mjs');
  assert.equal(jstDate(new Date('2026-12-31T15:01:00Z')),'2027-01-01');
  const cancelled={status:'cancelled',event_date:'2028-02-29',progress:{confirmed_event_date:'2028-02-28'}};
  const closed={status:'closed',event_date:'2028-02-01',progress:{confirmed_event_date:'2028-02-29'}};
  const view=caseCalendar([cancelled,closed,{event_date:'2028-02-30'}],'2028-02');
  assert.equal(view.days.length%7,0);
  assert.equal(view.days.filter(day=>day.inMonth).length,29);
  assert.equal(view.entries.get('2028-02-28')[0].label,'取消');
  assert.equal(view.entries.get('2028-02-29')[0].label,'確保日');
  assert.equal(view.undated,1);

  const requests=[],errors=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/fixture-workspace'){
      const route=url.searchParams.get('path');
      requests.push({route,method:req.method});
      let result=[];
      if(route==='/data/cases') result={cases,progress};
      else if(route.startsWith('/data/commercial/')) result={estimates:[],offers:[],billings:[]};
      else if(route.startsWith('/data/materials/'))result={cards:[],photos:[]};
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({ok:true,result}));
    }
    if(url.pathname.startsWith('/api/')){
      requests.push({route:url.pathname,method:req.method});
      return res.writeHead(404).end();
    }
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
    const type={'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css'}[path.extname(file)];
    res.setHeader('Content-Type',type||'application/octet-stream');
    return fs.createReadStream(file).pipe(res);
  });
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch();
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.route(origin+'/pa-ui/js/integration.mjs',route=>route.fulfill({
      contentType:'text/javascript',body:`
      const session={user:{id:'fixture-admin'},access_token:'fixture-only',expires_at:9999999999};
      export const workspaceAuth={restore:async()=>session,current:async()=>session};
      export const readUrl=p=>'/fixture-workspace?path='+encodeURIComponent(p);
      export const legacyUrl=id=>'/pa-admin-legacy.html?case='+encodeURIComponent(id);`
    }));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/pa-admin.html?case='+first+'&mail-view=readonly');
    await page.getByRole('heading',{name:'開催希望の架空案件',exact:true}).waitFor();
    await page.getByRole('button',{name:'案件カレンダー',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'案件カレンダー',exact:true});
    await dialog.getByText('2026年 12月',{exact:true}).waitFor();
    assert.equal(await dialog.getByText('開催希望日 / 新規問い合わせ',{exact:true}).count(),1);
    assert.equal(await dialog.getByText(/開催日未定 1件/).count(),1);
    assert(await dialog.evaluate(node=>node.getBoundingClientRect().width<=innerWidth&&!([...node.querySelectorAll('button')].some(x=>x.getBoundingClientRect().x<0))));
    await dialog.getByRole('button',{name:'翌月',exact:true}).click();
    await dialog.getByText('2027年 1月',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'前月',exact:true}).click();
    await dialog.getByRole('button',{name:'2026-12-04 1件',exact:true}).click();
    await dialog.getByText('確保日 / 日程確保完了',{exact:true}).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'2026-12-02 1件',exact:true}).count(),1);
    await page.setViewportSize({width:1366,height:900});
    await dialog.getByRole('button',{name:/確保済みの架空案件/}).click();
    await page.getByRole('heading',{name:'日程案内・確定通知',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('case'),second);
    assert.equal(new URL(page.url()).searchParams.get('mail-view'),'readonly');
    assert.equal(context.pages().length,1);
    assert.deepEqual(errors,[]);
    assert(requests.length&&requests.every(call=>call.method==='GET'&&!call.route.startsWith('/api/')));
    console.log('PASS isolated CASE DESK calendar: JST, request vs confirmed date, closed/cancelled semantics, month navigation, mobile and read-only case open');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
