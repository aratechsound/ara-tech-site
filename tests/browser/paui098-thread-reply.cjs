const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {replySubject} = require('../../api/_pa-gmail.cjs');

async function verifyIntakeThreadReply({page, context, origin, inquiry, delivery, followUp, rows, state, transport, requests}) {
  const links = () => rows('select * from pa_gmail_thread_links where inquiry_id=$1', [inquiry.id]);
  const index = () => rows('select * from pa_gmail_message_index where inquiry_id=$1', [inquiry.id]);
  const form = p => p.locator('[data-timeline-kind="form"] [data-form-reply]');
  const composer = p => p.locator('#reply-composer-host .reply-composer');
  const payload = {action:'reply_context',inquiry_id:inquiry.id,reply_source_delivery_id:delivery.id,
    reply_source_message_id:followUp.id,reply_source_thread_id:followUp.threadId};
  const post = data=>context.request.post(origin+'/api/pa-gmail',{
    data,headers:{origin,authorization:'Bearer fixture-admin'}
  });
  const verifyContext = async p=>{
    const editor=composer(p);
    await editor.waitFor();
    await p.waitForFunction(email=>document.querySelector('[data-reply-to]')?.value===email,inquiry.email);
    assert.equal(await editor.locator('[data-reply-body]').inputValue(),'');
    assert.equal(await editor.locator('[data-reply-subject]').inputValue(),replySubject(delivery.subject));
    return editor;
  };

  assert.deepEqual(await links(),[]);
  assert.deepEqual(await index(),[]);
  assert.deepEqual(state.threadMessages.get(followUp.threadId).map(m=>m.labelIds),[['SENT']]);
  const before=transport.sent.length;
  for(const input of [{...payload,reply_source_thread_id:'wrong/thread'},
    {...payload,reply_source_delivery_id:randomUUID()},
    {...payload,reply_source_message_id:'other-valid-id'}]){
    assert((await post(input)).status()>=400);
  }
  const [actual] = state.threadMessages.get(followUp.threadId);
  const to = actual.payload.headers.find(h=>h.name==='To');
  const originalTo = to.value;
  to.value='unrelated@example.invalid';
  assert.equal((await post(payload)).status(),409);
  to.value=originalTo;
  const foreign=randomUUID();
  await rows("insert into pa_inquiries(id,inquiry_number,customer_name,email,case_type,status,submission_source) values($1,'PA-FIXTURE-FOREIGN','fixture',$2,'PA_EVENT','new','manual')",[foreign,inquiry.email]);
  await rows("insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role) values($1,$2,'manual','primary_conversation')",[foreign,followUp.threadId]);
  assert.equal((await post(payload)).status(),400);
  await rows('delete from pa_gmail_thread_links where inquiry_id=$1',[foreign]);
  const foreignMessage={...actual,id:'unrelated-sent',payload:{...actual.payload,headers:actual.payload.headers.map(h=>
    h.name==='To'?{...h,value:'unrelated@example.invalid'}:h)}};
  const input={...payload,mode:'normal',body:'混在スレッド確認用',cc_addresses:[]};
  const preview=await post({...input,action:'reply_preview'});
  assert.equal(preview.status(),200);
  const token=(await preview.json()).preview.confirmation_token;
  state.threadMessages.set(followUp.threadId,[actual,foreignMessage]);
  const unsafe=await post({...input,action:'send_reply',confirmation_token:token});
  assert.equal(unsafe.status(),400);
  assert.deepEqual(await links(),[]);
  state.threadMessages.set(followUp.threadId,[actual]);
  assert.equal(transport.sent.length,before);
  const attemptsBefore=requests.filter(r=>r.action==='send_reply').length;

  const readonly = await context.newPage();
  const readonlyPosts=[];
  readonly.on('request',r=>{if(r.method()==='POST')readonlyPosts.push(r.url());});
  await readonly.goto(page.url()+'&mail-view=readonly');
  await form(readonly).click();
  const readEditor=await verifyContext(readonly);
  assert.equal(await readEditor.locator('[data-reply-body]').isDisabled(),true);
  await readEditor.locator('[data-reply-preview]').click();
  await readEditor.frameLocator('iframe').getByText('表示確認用のサンプル本文です。',{exact:true}).waitFor();
  assert.equal(await readEditor.locator('[data-reply-send]').isHidden(),true);
  assert.deepEqual(readonlyPosts,[]);
  assert.deepEqual(await links(),[]);
  await readonly.close();

  for(const [i,body] of ['新しい案内をお送りします。','追加の確認事項です。'].entries()){
    await form(page).click();
    const editor=await verifyContext(page);
    await editor.locator('[data-reply-body]').fill(body);
    if(i===0){
      await editor.locator('[data-reply-files]').setInputFiles({
        name:'case-fixture.txt',mimeType:'text/plain',buffer:Buffer.from('isolated attachment')
      });
      await editor.getByText(/case-fixture\.txt/).waitFor();
    }
    await editor.locator('[data-reply-preview]').click();
    await editor.frameLocator('iframe').getByText(body,{exact:true}).waitFor();
    assert.equal(await editor.locator('[data-reply-send]').isDisabled(),true);
    assert.equal(transport.sent.length,before+i);
    assert.equal((await links()).length,i===0?0:1);
    await editor.locator('[data-reply-confirm]').check();
    await editor.locator('[data-reply-send]').evaluate(button=>{button.click();button.click();});
    await page.locator('[data-reply-notice-text]').getByText('送信しました',{exact:true}).waitFor();
    const sent=transport.sent.at(-1);
    assert.equal(transport.sent.length,before+i+1);
    assert.equal(sent.threadId,followUp.threadId);
    assert.equal(sent.recipient,inquiry.email);
    const rfc=actual.payload.headers.find(h=>h.name==='Message-ID').value;
    assert(sent.mime.includes('In-Reply-To: '+rfc));
    assert(sent.mime.includes('References: '+rfc));
    const plain=sent.mime.split(/Content-Type: text\/plain; charset=UTF-8\r?\nContent-Transfer-Encoding: 8bit\r?\n\r?\n/u)[1].split(/\r?\n--/u)[0];
    assert(plain.includes(body));
    assert(!plain.includes(delivery.body.split('\n')[0]));
    assert.equal((await links())[0].gmail_thread_id,followUp.threadId);
    assert((await index()).some(m=>m.gmail_message_id===sent.id&&m.gmail_thread_id===followUp.threadId&&m.direction==='outbound'));
    assert.equal(await page.locator('[data-message="'+sent.id+'"]').count(),1);
    await page.reload();
    await page.locator('[data-message="'+sent.id+'"]').waitFor();
  }
  assert.equal(requests.filter(r=>r.action==='send_reply').length-attemptsBefore,2);
  const thread=state.threadMessages.get(followUp.threadId);
  assert.equal(thread.length,3);
  assert(thread.every(m=>m.labelIds.includes('SENT')));

  await form(page).click();
  const editor=await verifyContext(page);
  await editor.locator('[data-reply-body]').fill('不明結果の合成試験です。');
  await editor.locator('[data-reply-preview]').click();
  await editor.frameLocator('iframe').getByText('不明結果の合成試験です。',{exact:true}).waitFor();
  await editor.locator('[data-reply-confirm]').check();
  const originalFetch=global.fetch;
  let unknownAttempts=0;
  global.fetch=(url,options)=>{
    if(new URL(url).hostname==='gmail.googleapis.com'&&new URL(url).pathname.endsWith('/messages/send')){
      unknownAttempts++;
      return Promise.resolve(new Response('{}',{status:503}));
    }
    return originalFetch(url,options);
  };
  try{
    await editor.locator('[data-reply-send]').click();
    await editor.getByText(/送信結果UNKNOWN/).waitFor();
    await page.reload();
    await page.getByText('送信結果を確認できない記録があります。配送履歴を確認してください。',{exact:true}).waitFor();
    assert.equal(await form(page).isDisabled(),true);
    assert.equal(unknownAttempts,1);
    assert.equal(transport.sent.length,before+2);
  }finally{global.fetch=originalFetch;}
  console.log(JSON.stringify({scope:'PAUI098_MOCK_GMAIL_E2E',width:page.viewportSize().width,
    verifiedOriginalOutbound:true,linkedOnlyAtFinalSend:true,confirmedNewMessages:2,threadSentMessages:3,
    linkedCaseHistory:true,unknownAttempts,readonlyPosts:0,liveSends:0,productionWrites:0}));
}

module.exports={verifyIntakeThreadReply};
