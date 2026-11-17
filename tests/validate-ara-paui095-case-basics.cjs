const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {createFixture} = require('./helpers/ara-case-fixture.cjs');

const root = path.resolve(__dirname,'..');
const first = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const held = '33333333-3333-4333-8333-333333333333';
const outsider = '44444444-4444-4444-8444-444444444444';
const keys = new Set(['customer_name','organization_name','phone','event_name','venue']);

async function main(){
  const {db,actor,state}=await createFixture();
  await db.query(`insert into auth.users(id) values($1)`,[outsider]);
  await db.query(`insert into pa_inquiries(id,customer_name,email,event_name,status,case_type) values
    ($1,'架空担当者','customer@example.invalid','架空案件','new_inquiry','PA_EVENT'),
    ($2,'別案件担当者','other@example.invalid','別の架空案件','new_inquiry','PA_EVENT'),
    ($3,'保留案件担当者','hold@example.invalid','保留の架空案件','on_hold','PA_EVENT')`,[first,other,held]);
  const rows=async(sql,args)=>(await db.query(sql,args)).rows;
  const find=async id=>(await rows('select * from pa_inquiries where id=$1',[id]))[0];
  const baseline=await find(first),otherBefore=await find(other);
  async function patch({id,revision,deletedAt,changes},user){
    assert.equal(deletedAt,null);
    const entries=Object.entries(changes);
    assert(entries.length&&entries.every(([key])=>keys.has(key)));
    return db.transaction(async tx=>{
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
      const values=entries.map(([,value])=>value);
      const update=entries.map(([key],index)=>`${key}=$${index+3}`).join(',');
      const result=await tx.query(`update public.pa_inquiries set ${update} where id=$1 and revision=$2 and deleted_at is null returning id,revision`,[id,revision,...values]);
      return result.rows[0]||null;
    });
  }
  assert.equal(await patch({id:first,revision:baseline.revision,deletedAt:null,changes:{venue:'権限外変更'}},outsider),null);
  assert.deepEqual(await find(first),baseline);

  const writes=[],errors=[],unexpected=[];
  let staleProjection=false;
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    const json=(result,status=200)=>{
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    };
    try{
      if(u.pathname==='/fixture-case-update'){
        assert.equal(req.method,'PATCH');
        const chunks=[];
        for await(const chunk of req)chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        writes.push(input);
        return json({data:await patch(input,actor),error:null});
      }
      if(u.pathname==='/fixture-case-read'){
        assert.equal(req.method,'GET');
        const route=u.searchParams.get('path');
        let result=[];
        if(route==='/data/cases'){
          const cases=await rows('select * from pa_inquiries where deleted_at is null');
          result={cases:staleProjection?cases.map(row=>row.id===first?baseline:row):cases,progress:[]};
        }else if(route.startsWith('/data/commercial/'))result={estimates:[],offers:[],billings:[]};
        else if(route.startsWith('/data/materials/'))result={cards:[],photos:[]};
        else if(route.endsWith('/audit'))result=await rows('select * from pa_inquiry_audit where inquiry_id=$1',[route.split('/')[3]]);
        return json({ok:true,result});
      }
      if(u.pathname.startsWith('/api/')){
        unexpected.push(u.pathname);
        return json({},404);
      }
      const target=path.resolve(root,'.'+decodeURIComponent(u.pathname));
      if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return json({},404);
      const type={'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css'}[path.extname(target)];
      res.writeHead(200,{'Content-Type':type||'application/octet-stream'});
      fs.createReadStream(target).pipe(res);
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
      import {saveCaseBasics} from './case-basics.mjs';
      const session={user:{id:${JSON.stringify(actor)}},access_token:'fixture-only',expires_at:9999999999};
      export const workspaceAuth={restore:async()=>session,current:async()=>session};
      export const readUrl=p=>'/fixture-case-read?path='+encodeURIComponent(p);
      export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;
      export function updateCaseBasics(input){
        if(input.ownerId!==session.user.id)throw Error('login_required');
        const sent={};
        const query={
          update(changes){sent.changes=changes;return this;},
          eq(key,value){sent[key]=value;return this;},
          is(key,value){if(key!=='deleted_at')throw Error('invalid_fixture_filter');sent.deletedAt=value;return this;},
          select(fields){if(fields!=='id,revision')throw Error('invalid_fixture_projection');return this;},
          async maybeSingle(){const res=await fetch('/fixture-case-update',{method:'PATCH',body:JSON.stringify(sent)});return res.json();}
        };
        return saveCaseBasics({from(table){if(table!=='pa_inquiries')throw Error('invalid_fixture_table');return query;}},input);
      }`}));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    const open = id => page.goto(origin+'/pa-admin.html?case='+id);
    const edit=page.getByRole('button',{name:'基本情報を編集',exact:true});
    const dialog=page.getByRole('dialog',{name:'案件の基本情報を編集',exact:true});
    const submit=dialog.getByRole('button',{name:'基本情報を保存',exact:true});
    await open(first);
    await edit.click();
    assert.equal(await dialog.locator('[name=email],[name=status],[name=event_date]').count(),0);
    assert(await dialog.evaluate(node=>node.getBoundingClientRect().width<=innerWidth));
    await submit.click();
    await dialog.getByText('変更はありません。',{exact:true}).waitFor();
    assert.equal(writes.length,0);
    await dialog.getByLabel('会場',{exact:true}).fill('確認済みの架空会場');
    await submit.evaluate(button=>{button.click();button.click();});
    await page.getByText('基本情報を保存しました。',{exact:true}).waitFor();
    await dialog.waitFor({state:'detached'});
    assert.equal(writes.length,1);
    assert.deepEqual(writes[0],{id:first,revision:baseline.revision,deletedAt:null,changes:{venue:'確認済みの架空会場'}});
    const after=await find(first);
    assert.equal(after.revision,baseline.revision+1);
    assert.equal(after.email,baseline.email);
    assert.equal(after.status,baseline.status);
    assert.deepEqual(await find(other),otherBefore);
    assert.equal((await rows("select actor_user_id from pa_inquiry_audit where inquiry_id=$1 and action='case_updated'",[first]))[0].actor_user_id,actor);
    await page.reload();
    await page.getByText(/確認済みの架空会場/).first().waitFor();

    await edit.click();
    await db.query("update pa_inquiries set venue='別操作の会場' where id=$1",[first]);
    await dialog.getByLabel('会場',{exact:true}).fill('競合する古い下書き');
    await submit.click();
    await dialog.getByText(/別の操作で案件が更新されました/u).waitFor();
    assert.equal(await submit.isDisabled(),true);
    assert.equal((await find(first)).venue,'別操作の会場');
    await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.reload();

    await edit.click();
    staleProjection=true;
    await dialog.getByLabel('電話',{exact:true}).fill('000-0000-0000');
    await submit.click();
    await dialog.getByText(/保存結果を確認できません/u).waitFor();
    assert.equal(await submit.isDisabled(),true);
    assert.equal((await find(first)).phone,'000-0000-0000');
    assert.equal(writes.length,3);
    staleProjection=false;
    await open(held);
    await page.getByRole('heading',{name:'案件の基本情報',exact:false}).waitFor();
    assert.equal(await edit.count(),0);
    await page.goto(origin+'/pa-admin.html?case='+first+'&mail-view=readonly');
    await page.getByRole('heading',{name:'案件の基本情報',exact:false}).waitFor();
    assert.equal(await edit.count(),0);
    assert.deepEqual(unexpected,[]);
    assert.deepEqual(errors,[]);
    assert.equal(state.sendCount,0);
    console.log('PASS isolated CASE DESK basics: scoped RLS, audit actor, revision conflict, verified readback, duplicate guard, readonly and HOLD');
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
    await db.close();
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
