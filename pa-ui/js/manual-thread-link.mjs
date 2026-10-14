import {escape} from './model.mjs';

// Owner explicitly chooses a thread and approves the legacy manual_link action.
// Reads/searches never call sync. An uncertain POST is never retried here.
export function createThreadLink({read,write,open,current,refresh,candidates=()=>null}) {
  let generation=0;const attempted=new Set();
  const date=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'日時未取得';
  function show(){
    const c=current();if(!c)return;
    const epoch=++generation,valid=()=>epoch===generation&&current()?.id===c.id&&current()?.epoch===c.epoch;
    open('顧客メールを関連付け',`<p><strong>${escape(c.name)}</strong></p><p class="hint">登録された顧客メールアドレスから、送信元・送信先の双方を検索します。メールを選び、内容と案件帰属を確認してください。検索・内容確認ではDB保存しません。</p>
      <button id="thread-reload" class="action quiet">候補を再取得</button>
      <div id="thread-results" role="status"></div><div id="thread-preview"></div>`);
    const results=document.getElementById('thread-results'),preview=document.getElementById('thread-preview');let requestId=0;
    async function choose(id){
      const request=++requestId;
      preview.textContent='関連付け・メール・同期範囲を読取確認中…';
      try{
        const v=await read('/data/mail-thread-preview/'+c.id+'/'+encodeURIComponent(id));if(!valid()||request!==requestId)return;
        if(v.gmail_thread_id!==id||!Array.isArray(v.messages)||v.messages.some(m=>m.inquiry_id!==c.id||m.gmail_thread_id!==id))throw Error('invalid_preview');
        preview.innerHTML=`<section class="group"><h3>${v.already_linked?'関連付け済み':'関連付け前の確認'}</h3><p>案件 ${escape(c.name)} / スレッド ${escape(id)}</p>
          ${v.already_linked?'<p>重複登録はしません。「最新メールを取得」でこのスレッドも読み取ります。</p>':''}
          <p>対象 ${v.messages.length}件 / 保存済み索引 ${Number(v.target_indexed_count)}件 / 不足 ${v.target_missing_ids.length}件</p>
          <div class="rows">${v.messages.map(m=>`<article class="record"><strong>${escape(m.subject)}</strong><time>${escape(date(m.occurred_at))}</time><p>${escape(m.direction==='inbound'?'受信':'送信')} / ${escape(m.from_address)} → ${escape((m.to_addresses||[]).join(', '))}</p><p>${escape(m.snippet)}</p></article>`).join('')}</div>
          ${v.already_linked?'<button id="thread-read-latest" class="action">最新メールを取得</button>':`<p>関連付け1件の登録に続き、この案件の全${v.sync_thread_ids.length}スレッド・現在${v.sync_message_count}メールを同期します。既存メール索引と索引更新日時の再記録、新着確認状態1件、関連付け・同期の操作記録各1件、資料候補検出（${v.sync_attachment_count}添付が入力）を伴います。配送照合による受付通知等のリンク再記録や候補照合の更新件数は、この確認では確定できません。契約・見積・請求やGmailの送信・削除・既読は変更しません。</p>
            ${v.preflight_complete?'':'<p role="alert">同期範囲の取得が不完全です。関連付けは実行できません。</p>'}
            <label><input type="checkbox" id="thread-owner-approved"> このスレッドの案件帰属と、上記のDB更新・副作用を確認し承認する</label>
            <button id="thread-link-confirm" class="action" disabled>関連付けて同期（DB更新）</button>`}</section>`;
        if(v.already_linked){document.getElementById('thread-read-latest').onclick=async()=>{if(valid()){++generation;document.getElementById('modal-wrap').classList.remove('open');await refresh();}};return;}
        const confirm=document.getElementById('thread-link-confirm'),approved=document.getElementById('thread-owner-approved');
        const key=c.id+'/'+id;
        if(attempted.has(key))results.textContent='このセッションで保存操作を試行済みです。再実行せず、正規記録を確認してください。';
        approved.onchange=()=>{confirm.disabled=!approved.checked||!v.preflight_complete||attempted.has(key);};
        confirm.onclick=async()=>{
          if(!valid()||!approved.checked||confirm.disabled)return;
          // Invalidate the entire selection once DML may start. No search,
          // reselect, second Submit, automatic retry or automatic rollback.
          ++generation;
          attempted.add(key);
          for(const el of document.querySelectorAll('#modal-content input,#modal-content button'))el.disabled=true;
          results.textContent='関連付け・同期を実行中…';
          try{
            await write({action:'manual_link',inquiry_id:c.id,gmail_thread_id:id,conversation_role:'secondary_conversation'});
            results.textContent='操作結果を取得しました。案件の最新メールを読取確認しています。';
            if(current()?.id===c.id&&current()?.epoch===c.epoch)await refresh();
          }catch{results.textContent='結果UNKNOWN。リンク・索引・attention・audit・候補の一部が保存済みの可能性があります。再実行せず、保存済み記録を確認してください。';}
        };
      }catch{if(valid()&&request===requestId)preview.textContent='関連付け・帰属・Gmailの読取に失敗しました。別案件への帰属、権限、通信状態を確認してください。DB保存は行いません。';}
    }
    async function load(initial){
      if(!valid())return;
      const searchEpoch=++requestId;results.textContent='検索中…';preview.replaceChildren();
      try{const v=initial||await read('/data/mail-candidates/'+c.id);if(!valid()||searchEpoch!==requestId)return;
        // A new search is a new local selection; it never changes a case link.
        results.innerHTML=`<p>検索元 ${escape(v.customer_email)} / 同じアドレスの案件 ${Number(v.matching_case_count)}件</p>${v.matching_case_count!==1?'<p>同じ顧客の複数案件があるため自動選択しません。メール内容と案件帰属を確認してください。</p>':''}`+
          ((v.candidates||[]).map(t=>`<p><button class="action quiet" data-choose-thread="${escape(t.gmail_thread_id)}" ${t.conflict||t.unknown||!t.address_match?'disabled':''}>${escape(t.subject||t.snippet||'件名未取得')} / ${escape(date(t.latest_at))} / ${t.conflict?'別案件に関連付け済み':t.unknown?'取得不明':t.already_linked?'関連付け済み':t.related?'案件情報一致の候補':'Owner確認が必要'}</button></p>`).join('')||'<p>検索結果0件</p>');
        if(v.truncated)results.insertAdjacentHTML('beforeend','<p>先頭10スレッドまたは取得できた範囲です。全件確認済みではありません。自動選択は行いません。</p>');
        for(const b of results.querySelectorAll('[data-choose-thread]'))b.onclick=()=>choose(b.dataset.chooseThread);
        if(v.auto_selected_thread_id){results.insertAdjacentHTML('beforeend','<p>顧客アドレスの案件が1件で案件情報も一致したため、最新の候補を選択しました。DBへの関連付けは承認するまで行いません。</p>');await choose(v.auto_selected_thread_id);}
      }catch{if(valid()&&searchEpoch===requestId)results.textContent='Gmail検索に失敗しました。DB保存は行いません。';}
    }
    document.getElementById('thread-reload').onclick=()=>load(null);
    void load(candidates());
  }
  return {show,reset(){++generation;}};
}
