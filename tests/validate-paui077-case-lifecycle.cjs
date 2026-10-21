'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright'),{createFixture}=require('./helpers/ara-case-fixture.cjs');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),checks=[];
const clean=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const mod=await import(pathToFileURL(path.join(root,'pa-ui/js/pa-case-completion.mjs'))),model=await import(pathToFileURL(path.join(root,'pa-ui/js/model.mjs')));
 const f=await createFixture(),db=f.db;
 try{
  const candidate=read('ops/PAUI-077-manual-close-CANDIDATE.sql'),prior=read('supabase/migrations/20261007040000_case_close_002_owner_payment_completion.sql');
  assert.equal(candidate.slice(candidate.indexOf('  select key')),prior.slice(prior.indexOf('  select key')),'ordinary progress body preserved');
  assert(!/create\s+(?:table|trigger)|grant\s|delete\s+from/i.test(candidate));
  await db.exec(candidate);checks.push('existing_rpc_signature_acl_ordinary_progress_preserved');
  const add=async n=>(await db.query("insert into pa_inquiries(customer_name,email,event_name,event_date,case_type,status,request_summary) values($1,'fixture@example.invalid','Synthetic PA','2020-01-01','PA_EVENT','new_inquiry','retained original') returning *",['Fixture '+n])).rows[0];
  const row=async id=>clean((await db.query('select * from pa_inquiries where id=$1',[id])).rows[0]);
  const progress=async id=>clean((await db.query('select * from pa_case_progress where inquiry_id=$1',[id])).rows[0]);
  const commercial=async id=>({case_status:(await row(id)).status,state:{inquiry_id:id,revision:0,unresolved_changes:false},offers:[],billings:[],payments:[],adjustments:[],outbox:[],change_orders:[]});
  const client={from(table){const filters=[];const b={select(){return b;},eq(k,v){assert(['id','inquiry_id'].includes(k));filters.push([k,v]);return b;},async single(){const result=await db.query(`select * from ${table} where ${filters.map(([k],i)=>k+'=$'+(i+1)).join(' and ')}`,filters.map(x=>x[1]));return {data:clean(result.rows[0]),error:result.rows.length===1?null:{}};}};return b;},async rpc(name,args){assert.equal(name,'update_pa_case_progress');try{await db.exec('set role authenticated');const r=await db.query('select update_pa_case_progress($1,$2::jsonb,$3)',[args.p_inquiry_id,JSON.stringify(args.p_progress),args.p_note]);return {data:r.rows[0],error:null};}catch(e){return {data:null,error:e};}finally{await db.exec('reset role');}}};
  const auth={restore:async()=>true},request=async(action,input)=>{assert.equal(action,'snapshot');return commercial(input.case_id);};
  for(const choice of ['declined','cancelled','closed']){
   const c=clean(await add(choice)),a=await mod.readPaCloseAuthority(client,auth,c,request);
   const saved=await mod.savePaClose(client,auth,c,choice,a,request);
   assert.equal(saved.status,choice);assert.equal(saved.request_summary,c.request_summary);assert.equal(saved.email,c.email);assert(model.isClosedCase(saved));assert.equal(model.filterCases([saved],{review:'active'}).length,0);assert.equal(model.filterCases([saved],{review:'completed'}).length,1);
   assert.equal((await db.query("select count(*)::int n from pa_inquiry_audit where inquiry_id=$1 and action='manual_case_closed'",[c.id])).rows[0].n,1);
   await assert.rejects(()=>mod.savePaClose(client,auth,c,choice,a,request));
  }checks.push('three_distinct_manual_statuses_real_rpc_audit_list_history_no_replay');
  const c=clean(await add('ordered')),a=await mod.readPaCloseAuthority(client,auth,c,request);
  await db.query("update pa_case_progress set booking_confirmed_on='2026-10-01',updated_at=now() where inquiry_id=$1",[c.id]);
  await assert.rejects(()=>mod.savePaClose(client,auth,c,'declined',a,request),/stale/);
  const fresh=await mod.readPaCloseAuthority(client,auth,c,request);assert.equal(mod.paClosePolicy(fresh).canOrdinary,false);
  const direct=await client.rpc('update_pa_case_progress',{p_inquiry_id:c.id,p_progress:{manual_close_status:'declined',expected_status:c.status,expected_revision:c.revision,expected_updated_at:c.updated_at,expected_progress_updated_at:fresh.progress.updated_at}});
  assert.match(direct.error.message,/commercial records protected/);assert.equal((await row(c.id)).status,'new_inquiry');checks.push('concurrent_order_before_rpc_and_direct_rpc_protected');
  await assert.rejects(()=>mod.savePaClose(client,auth,c,'owner_payment_completed',fresh,request,false),/blocked/);
  const paid=await mod.savePaClose(client,auth,c,'owner_payment_completed',fresh,request,true);assert.equal(paid.progress.close_reason,'payment_received');assert.equal((await db.query('select count(*)::int n from pa_payment_records')).rows[0].n,0);checks.push('explicit_owner_attestation_existing_rpc_no_invented_payment');
  const stale=clean(await add('stale')),sa=await mod.readPaCloseAuthority(client,auth,stale,request);await db.query("update pa_inquiries set internal_memo='concurrent edit' where id=$1",[stale.id]);await assert.rejects(()=>mod.savePaClose(client,auth,stale,'closed',sa,request),/stale/);checks.push('inquiry_revision_conflict_stops');
  const forbidden=clean(await add('non_owner'));await db.exec("select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174099',false)");const denied=await client.rpc('update_pa_case_progress',{p_inquiry_id:forbidden.id,p_progress:{manual_close_status:'closed'}});assert.match(denied.error.message,/not authorized/);await db.exec(`select set_config('request.jwt.claim.sub','${f.actor}',false)`);checks.push('rpc_non_owner_refused');
  const base={inquiry:forbidden,progress:await progress(forbidden.id),commercial:await commercial(forbidden.id)};
  for(const key of ['billings','payments','adjustments','offers','change_orders']){const s=clean(base);s.commercial[key]=[{state:'open'}];assert.equal(mod.paClosePolicy(s).canOrdinary,false);}
  for(const j of [{state:'unknown'},{state:'processing'},{state:'sent',delivery_state:'unknown_after_provider_start'}]){const s=clean(base);s.commercial.outbox=[j];assert.equal(mod.paClosePolicy(s).canOrdinary,false);}
  assert.equal(model.isClosedCase({...forbidden,event_date:'2000-01-01',progress:{event_completed_on:'2000-01-02'}}),false);checks.push('commercial_unpaid_unknown_protected_no_date_auto_close');
  const v5=clean(base);v5.progress.booking_confirmed_on='2026-10-01';Object.assign(v5.commercial.state,{fulfillment_state:'confirmed',settlement_state:'confirmed',final_settlement_minor:10000});v5.commercial.billings=[{id:'billing',state:'open',amount_minor:10000,invoice_policy:'no_separate_invoice'}];assert.equal(mod.paClosePolicy(v5).canPaid,false);v5.commercial.payments=[{id:'payment',billing_id:'billing',amount:10000}];assert.equal(mod.paClosePolicy(v5).canPaid,true);checks.push('paid_v5_route_requires_recorded_exact_balance_not_amount_guess');
  const vc=clean(await add('v5_paid')),crypto=require('node:crypto'),offer=crypto.randomUUID(),document=crypto.randomUUID(),estimate=crypto.randomUUID(),billing=crypto.randomUUID();
  const pdf='PDF fixture bytes with more than twenty bytes';
  await db.query("insert into pa_contract_offers(id,inquiry_id,version,expires_at,issued_by,snapshot,snapshot_sha256,quote_pdf,quote_sha256) values($1,$2,1,now()+interval '1 day',$3,'{}',repeat('0',64),convert_to($4,'UTF8'),encode(sha256(convert_to($4,'UTF8')),'hex'))",[offer,vc.id,f.actor,pdf]);
  await db.query("insert into pa_contracts(id,inquiry_id,version,confirmed_at,snapshot,snapshot_sha256) values($1,$2,1,now(),'{}',encode(sha256(convert_to('{}'::jsonb::text,'UTF8')),'hex'))",[offer,vc.id]);
  await db.query("insert into pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,created_by) values($1,$2,'estimate','private_upload','fixture.pdf','application/pdf',convert_to($3,'UTF8'),encode(sha256(convert_to($3,'UTF8')),'hex'),$4)",[document,vc.id,pdf,f.actor]);
  await db.query("insert into pa_estimate_revisions(id,inquiry_id,revision_number,document_id,amount_minor,tax_basis,conditions_snapshot,source_kind,issued_by,operation_id) values($1,$2,1,$3,10000,'tax_included','{}','managed_send',$4,gen_random_uuid())",[estimate,vc.id,document,f.actor]);
  await db.query("insert into pa_billings(id,inquiry_id,billing_number,contract_id,estimate_revision_id,amount_minor,invoice_policy,invoice_delivery_state,due_basis,agreement_evidence,operation_id,created_by) values($1,$2,1,$3,$4,10000,'no_separate_invoice','not_required','{\"status\":\"unconfirmed\"}','{}',gen_random_uuid(),$5)",[billing,vc.id,offer,estimate,f.actor]);
  await db.query("insert into pa_case_commercial_state(inquiry_id,fulfillment_state,settlement_state,final_settlement_minor) values($1,'confirmed','confirmed',10000)",[vc.id]);
  await db.query("update pa_case_progress set booking_confirmed_on='2026-10-01',updated_at=now() where inquiry_id=$1",[vc.id]);
  const requestV5=async(action,input)=>{
   if(action==='close_case'){assert.equal(input.new_payment_minor,0);assert(!input.payment_method&&!input.payment_date);return (await db.query('select pa_v5_payment_and_close($1,$2,$3,$4,$5,null,0,null,$6) value',[f.actor,vc.id,billing,input.expected_revision,input.operation_id,input.memo])).rows[0].value;}
   assert.equal(action,'snapshot');const data=await commercial(vc.id);data.state=clean((await db.query('select * from pa_case_commercial_state where inquiry_id=$1',[vc.id])).rows[0]);for(const [key,table]of [['billings','pa_billings'],['payments','pa_payment_records'],['adjustments','pa_payment_adjustments']])data[key]=clean((await db.query('select * from '+table+' where inquiry_id=$1',[vc.id])).rows);data.offers=[{id:offer,state:'accepted'}];return data;
  };
  const va=await mod.readPaCloseAuthority(client,auth,vc,requestV5);assert.equal(mod.paClosePolicy(va).canPaid,false);await assert.rejects(()=>mod.savePaClose(client,auth,vc,'closed',va,requestV5),/blocked/);
  const legacyBypass=await client.rpc('update_pa_case_progress',{p_inquiry_id:vc.id,p_progress:{close_reason:'payment_received'}});assert.match(legacyBypass.error.message,/use commercial/);
  await db.query("select pa_v5_record_payment($1,$2,$3,gen_random_uuid(),'2026-10-20',10000,'bank_transfer','synthetic fixture evidence')",[f.actor,vc.id,billing]);
  const beforePaymentCount=(await db.query('select count(*)::int n from pa_payment_records')).rows[0].n,ready=await mod.readPaCloseAuthority(client,auth,vc,requestV5);
  const done=await mod.savePaClose(client,auth,vc,'owner_payment_completed',ready,requestV5,true);assert.equal(done.status,'closed');assert.equal((await db.query('select state from pa_billings where id=$1',[billing])).rows[0].state,'paid');assert.equal((await db.query('select count(*)::int n from pa_payment_records')).rows[0].n,beforePaymentCount);checks.push('real_v5_balance_checked_close_zero_new_payment_legacy_bypass_refused');
  assert.equal(f.state.sendCount,0);
 }finally{await db.close();}
 const server=http.createServer((req,res)=>{const p=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+path.sep)||req.method!=='GET')return res.writeHead(403).end();try{res.setHeader('content-type',/\.m?js$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(p));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true,...(process.env.PAUI077_CHROMIUM?{executablePath:process.env.PAUI077_CHROMIUM}:{})}).catch(async e=>{await new Promise(r=>server.close(r));throw e;});
 try{
  for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
   await page.goto(base+'/tests/paui077-preview.html');await page.getByRole('button',{name:'ログアウト',exact:true}).waitFor();
   const caseButton=page.locator('[data-case]').first();await caseButton.click();
   await page.getByRole('button',{name:'終了方法を確認する',exact:true}).waitFor();
   assert.equal(await page.locator('#detail-card > :last-child').getByRole('heading',{name:'不要案件の整理'}).count(),1);
   await page.getByRole('button',{name:'終了方法を確認する',exact:true}).click();const d=page.getByRole('dialog',{name:'PA案件の終了処理'});await d.getByRole('combobox',{name:'終了方法'}).waitFor();assert.equal(await d.getByRole('button',{name:'終了状態を保存'}).isEnabled(),false);
   for(const choice of ['declined','cancelled','closed']){await d.getByRole('combobox').selectOption(choice);assert.equal(await d.getByRole('button',{name:'終了状態を保存'}).isEnabled(),false);}
   await d.getByRole('checkbox').check();await d.getByRole('button',{name:'終了状態を保存'}).click();await d.getByRole('status').getByText(/再送停止/).waitFor();assert.equal(await d.getByRole('button',{name:'終了状態を保存'}).isEnabled(),false);assert.equal(await d.getByRole('combobox').isEnabled(),false);
   const out=process.env.PAUI077_EVIDENCE;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'PA_ENDING_'+width+'.png')});}
   await d.getByRole('button',{name:'閉じる',exact:true}).click();await page.getByRole('button',{name:'ゴミ箱へ移動',exact:true}).click();const trash=page.getByRole('dialog',{name:'案件をゴミ箱へ移動'});assert.equal(await trash.getByRole('combobox').locator('option').count(),4);assert.equal(await trash.getByRole('button',{name:'ゴミ箱へ移動する',exact:true}).isEnabled(),false);await trash.getByRole('checkbox').check();let confirmations=0;page.once('dialog',async dialog=>{confirmations++;await dialog.dismiss();});await trash.getByRole('button',{name:'ゴミ箱へ移動する',exact:true}).click();assert.equal(confirmations,1);await trash.getByRole('button',{name:'キャンセル',exact:true}).click();
   const types=['OTHER','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL'];
   for(const type of types){await page.goto(base+'/tests/paui077-preview.html?case='+`11111111-1111-4111-8111-${String(types.indexOf(type)+2).padStart(12,'0')}`);await page.getByRole('button',{name:'ゴミ箱へ移動',exact:true}).waitFor();await page.getByRole('button',{name:'ゴミ箱へ移動',exact:true}).click();const t=page.getByRole('dialog');assert((await t.innerText()).includes('架空の案件名 '+type));assert(!(await t.innerText()).includes('イベント名未設定'));assert((await t.innerText()).includes('架空の担当者'));if(out&&type==='OTHER')await page.screenshot({path:path.join(out,'GENERAL_TRASH_'+width+'.png')});await t.getByRole('button',{name:'キャンセル',exact:true}).click();}
   assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);checks.push('pc_mobile_all_seven_trash_bottom_identity_two_stage_no_writes_'+width);await page.close();
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
 console.log(JSON.stringify({status:'PASS',checks,production_changed:false,production_db_writes:0,gmail_sent:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
