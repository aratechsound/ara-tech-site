const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {createFixture} = require('./helpers/ara-case-fixture.cjs');

const root=path.resolve(__dirname,'..');
const columns=['id','customer_name','email','organization_name','phone','event_name',
  'venue','event_time','request_summary','event_date','case_type','received_at','submission_source','status'];
const outsider='55555555-5555-4555-8555-555555555555';

async function main(){
  const {db,actor}=await createFixture();
  const results=async(sql,params)=>(await db.query(sql,params)).rows;
  const asUser=(user,fn)=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    return fn(tx);
  });
  await db.query('insert into auth.users(id) values($1)',[outsider]);
  await assert.rejects(()=>asUser(outsider,tx=>tx.query(
    "insert into pa_inquiries(customer_name,email) values('Fixture','nonowner@example.invalid')"
  )),{code:'42501'});

  const attempts=[],errors=[],unexpected=[];
  let nextWrite='lose-response',readUnavailable=true;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const json=(result,status=200)=>{
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    };
    try{
      if(url.pathname==='/fixture-manual'){
        if(req.method==='POST'){
          const chunks=[];
          for await(const chunk of req)chunks.push(chunk);
          const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.deepEqual(Object.keys(input).sort(),[...columns].sort());
          assert.equal(input.status,'new_inquiry');
          assert.equal(input.submission_source,'manual');
          attempts.push(input.id);
          const fault=nextWrite;
          nextWrite=null;
          if(fault!=='reject-before-insert'){
            const sql='insert into pa_inquiries ('+columns.join(',')+') values ('+
              columns.map((_,index)=>'$'+(index+1)).join(',')+')';
            await asUser(actor,tx=>tx.query(sql,columns.map(key=>input[key])));
          }
          if(fault)return json({data:null,error:{message:'fixture outage'}},503);
          return json({data:null,error:null});
        }
        assert.equal(req.method,'GET');
        if(readUnavailable)return json({data:null,error:{message:'fixture outage'}},503);
        const {rows}=await asUser(actor,tx=>tx.query(
          'select id,inquiry_number,created_by,submission_source,deleted_at from pa_inquiries where id=$1',
          [url.searchParams.get('id')]
        ));
        return json({data:rows[0]||null,error:null});
      }
      if(url.pathname==='/fixture-case-read'){
        assert.equal(req.method,'GET');
        const route=url.searchParams.get('path');
        let data=[];
        if(route==='/data/cases')data={
          cases:await results('select * from pa_inquiries'),
          progress:await results('select * from pa_case_progress')
        };
        if(route.startsWith('/data/commercial/'))data={estimates:[],offers:[],billings:[]};
        if(route.startsWith('/data/materials/'))data={cards:[],photos:[]};
        return json({ok:true,result:data});
      }
      if(url.pathname.startsWith('/api/'))unexpected.push(url.pathname);
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json({},404);
      const type={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css'}[path.extname(file)];
      res.writeHead(200,{'Content-Type':type||'application/octet-stream'});
      fs.createReadStream(file).pipe(res);
    }catch(error){errors.push(error.message);json({error:'fixture_error'},500);}
  });
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch();
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.route(origin+'/pa-ui/js/integration.mjs',route=>route.fulfill({contentType:'text/javascript',body:`
      import {manualIntakeRequest} from './manual-intake.mjs';
      const ownerId=${JSON.stringify(actor)};
      const session={user:{id:ownerId},access_token:'fixture-only',expires_at:9999999999};
      export const workspaceAuth={restore:async()=>session,current:async()=>session};
      export const readUrl=p=>'/fixture-case-read?path='+encodeURIComponent(p);
      export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;
      export function requestManualIntake(input){
        if(input.ownerId!==ownerId)throw Error('login_required');
        const query={
          insert(payload){this.payload=payload;return this;},
          select(){return this;},
          eq(field,id){if(field!=='id')throw Error('invalid_filter');this.id=id;return this;},
          abortSignal(signal){
            this.signal=signal;
            return this.payload?fetch('/fixture-manual',{method:'POST',body:JSON.stringify(this.payload),signal}).then(r=>r.json()):this;
          },
          maybeSingle(){return fetch('/fixture-manual?id='+encodeURIComponent(this.id),{signal:this.signal}).then(r=>r.json());}
        };
        return manualIntakeRequest({from(table){if(table!=='pa_inquiries')throw Error('invalid_table');return query;}},input);
      }`}));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/pa-admin.html');
    const add=page.getByRole('button',{name:'＋ 新規'});
    const dialog=page.getByRole('dialog',{name:'問い合わせを手入力'});
    const status=dialog.getByRole('status');
    const fill=async(name,kind)=>{
      await dialog.getByLabel('案件種別').selectOption(kind);
      await dialog.getByLabel('お客様名・担当者名').fill(name);
      await dialog.getByLabel('メールアドレス').fill('customer@example.invalid');
    };
    await add.click();
    assert.equal(context.pages().length,1);
    const box=await dialog.boundingBox();
    assert(box.x>=0&&box.x+box.width<=390);
    await fill('架空の音響依頼','PA_EVENT');
    await dialog.getByLabel('受付日時（JST）').fill('2026-11-18T07:30');
    await dialog.getByLabel('イベント名').fill('架空の催事');
    await dialog.getByRole('button',{name:'問い合わせを登録'}).dblclick();
    await status.getByText(/通信状態を確認してから/).waitFor();
    assert.equal(attempts.length,1);
    assert.equal(await dialog.getByRole('button',{name:/再試行/}).isEnabled(),false);
    const pendingId=await page.evaluate(id=>sessionStorage.getItem('pa-desk-manual-intake:'+id),actor);
    assert.equal(pendingId,attempts[0]);

    readUnavailable=false;
    await page.reload();
    await add.click();
    await status.getByText('前回の登録結果を確認してください。').waitFor();
    await dialog.getByRole('button',{name:'登録結果を確認'}).click();
    await dialog.waitFor({state:'hidden'});
    await page.locator('#manual-intake-status').getByText(/問い合わせを登録しました。 PA-/).waitFor();
    await page.waitForURL(url=>url.searchParams.get('case')===attempts[0]);
    assert.equal(attempts.length,1);
    assert.equal(await page.evaluate(id=>sessionStorage.getItem('pa-desk-manual-intake:'+id),actor),null);

    nextWrite='reject-before-insert';
    await add.click();
    await fill('架空の施工依頼','AV_INSTALL');
    await dialog.getByRole('button',{name:'問い合わせを登録'}).click();
    await status.getByText(/同じ問い合わせの内容で登録/).waitFor();
    await dialog.getByRole('button',{name:/再試行/}).click();
    await dialog.waitFor({state:'hidden'});
    await page.waitForURL(url=>url.searchParams.get('case')===attempts[1]);
    assert.equal(attempts.length,3);
    assert.equal(attempts[1],attempts[2]);
    assert.notEqual(attempts[0],attempts[1]);

    await page.goto(origin+'/pa-admin.html?mail-view=readonly');
    await page.locator('#case-count').getByText('(2)',{exact:true}).waitFor();
    assert.equal(await add.isEnabled(),false);
    assert.equal(await dialog.count(),0);
    const saved=await results('select id,case_type,created_by,status,submission_source from pa_inquiries order by case_type');
    assert.deepEqual(saved,[
      {id:attempts[1],case_type:'AV_INSTALL',created_by:actor,status:'new_inquiry',submission_source:'manual'},
      {id:attempts[0],case_type:'PA_EVENT',created_by:actor,status:'new_inquiry',submission_source:'manual'}
    ]);
    assert.deepEqual(await results('select inquiry_id from pa_case_progress'),[{inquiry_id:attempts[0]}]);
    const [received]=await results('select received_at from pa_inquiries where id=$1',[attempts[0]]);
    assert.equal(new Date(received.received_at).toISOString(),'2026-11-17T22:30:00.000Z');
    assert.equal((await results('select * from pa_inquiry_audit')).length,2);
    assert.equal((await results('select * from pa_email_deliveries')).length,0);
    assert.deepEqual(unexpected,[]);
    assert.deepEqual(errors,[]);
    console.log('PASS isolated manual intake: Owner RLS, mobile form, no legacy tab, lost response and reload readback, same-ID retry, audit, PA-only progress, zero mail');
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
    await db.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
