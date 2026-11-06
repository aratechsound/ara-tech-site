import {escape} from './model.mjs';
import {encodeAttachments} from './reply-state.mjs';
const errors={login_required:'認証を確認できません。再ログイン後にプレビューしてください。',preview_expired:'プレビューの有効期限が切れました。もう一度プレビューしてください。',body_required:'本文を入力してください（20,000文字以内）。',attachment_limit:'添付は10件・合計3 MB以内の空でないファイルを選択してください。',invalid_reply_binding:'返信元・宛先の一致を確認できません。返信元を選び直してください。',send_already_attempted:'この内容の送信は試行済みです。再送せず送信履歴を確認してください。',send_lock_unavailable:'二重送信防止の記録を利用できません。送信は停止しています。',invalid_reply_cc:'CCは選択したメールの参加者だけを指定できます。',send_outcome_unknown:'送信結果UNKNOWN。再送せず、送信記録とGmail履歴を確認してください。'};
export function createReplyComposer({state,readHistory}){
  let detach=()=>{};
  function mount(host){
    detach();if(!host)return;
    host.innerHTML=`<section class="reply-composer" aria-label="メール返信Composer" hidden>
      <div class="reply-heading"><h2>メールに返信</h2><button type="button" class="lightbtn" data-reply-close>閉じる（本文は保持）</button></div>
      <p class="hint">選択した受信メールと同じスレッドに返信します。プレビュー後、送信内容を確認して最終送信するまで送信されません。</p>
      <p data-reply-source class="reply-source"></p><p data-reply-status role="status" aria-live="polite"></p>
      <div class="reply-fields"><label>To<input data-reply-to readonly autocomplete="off"></label><label>CC（選択メールの参加者のみ）<input data-reply-cc type="text" autocomplete="off"></label></div>
      <label>件名<input data-reply-subject readonly></label>
      <label>本文<textarea data-reply-body rows="8" maxlength="20000"></textarea></label>
      <label>添付ファイル<input data-reply-files type="file" multiple></label><p class="hint">最大10件、合計3 MB。受信メールの添付は自動で付け直しません。</p><ul data-reply-files-list></ul>
      <div class="inlinebtns"><button type="button" class="action blue" data-reply-preview>プレビュー</button><button type="button" class="action quiet" data-reply-history>送信履歴を確認</button></div>
      <section class="reply-preview" data-reply-preview-box hidden><h3>送信前プレビュー</h3><p data-reply-preview-meta></p><iframe data-reply-frame title="ARA-TECH返信メールのプレビュー" sandbox="" referrerpolicy="no-referrer"></iframe><ul data-reply-preview-files></ul>
      <label class="reply-confirm"><input type="checkbox" data-reply-confirm> 宛先・返信元・本文・添付を確認しました</label><button type="button" class="action blue" data-reply-send disabled>確認した内容で送信する</button></section>
      <div data-reply-history-result></div></section>`;
    const q=s=>host.querySelector(s),panel=q('.reply-composer');let renderedToken=null;
    q('[data-reply-body]').oninput=e=>state.edit('body',e.target.value);
    q('[data-reply-cc]').oninput=e=>state.edit('cc',e.target.value);
    q('[data-reply-files]').onchange=async e=>{const c=state.get().caseId,source=state.get().source;state.edit('attachments',[]);try{const files=await encodeAttachments([...e.target.files]);if(state.get().caseId===c&&state.get().source===source)state.edit('attachments',files);}catch{state.attachmentError();}e.target.value='';};
    q('[data-reply-preview]').onclick=()=>state.preview();q('[data-reply-close]').onclick=()=>state.close();
    q('[data-reply-confirm]').onchange=e=>state.confirm(e.target.checked);q('[data-reply-send]').onclick=()=>state.send();
    q('[data-reply-history]').onclick=()=>state.history(readHistory);
    detach=state.subscribe(s=>{
      panel.hidden=!s.open;if(!s.open)return;
      const sending=s.phase==='sending',ctx=s.context;
      q('[data-reply-source]').textContent=`返信元：${s.source?.subject||'件名未提供'} / スレッド ${s.source?.gmail_thread_id||''} / メール ${s.source?.gmail_message_id||''}`;
      q('[data-reply-to]').value=ctx?.recipient||'返信先を確認中…';q('[data-reply-subject]').value=ctx?.subject||'';
      for(const field of ['body','cc']){const el=q('[data-reply-'+field+']');if(el.value!==s[field])el.value=s[field];el.disabled=sending;}
      q('[data-reply-history]').disabled=sending;q('[data-reply-files]').disabled=sending;q('[data-reply-close]').disabled=sending;
      q('[data-reply-files-list]').innerHTML=s.attachments.map((a,i)=>`<li>${escape(a.filename)}（${Math.ceil(a.size/1024)} KB） <button type="button" class="lightbtn" data-remove-file="${i}" ${sending?'disabled':''}>外す</button></li>`).join('');
      for(const b of host.querySelectorAll('[data-remove-file]'))b.onclick=()=>state.edit('attachments',s.attachments.filter((_,i)=>i!==Number(b.dataset.removeFile)));
      q('[data-reply-preview]').disabled=!ctx||!s.body.trim()||['sending','preview-loading','context-loading'].includes(s.phase)||state.blocked();
      const message=s.phase==='context-loading'?'返信先・スレッドの紐付けを確認中…':s.phase==='preview-loading'?'プレビューを確認中…':s.phase==='sending'?'送信中です。操作せず結果をお待ちください。':s.phase==='sent'?'送信結果を取得しました。送信履歴で確認できます。':state.blocked()?'送信結果UNKNOWNまたは処理中の記録があります。再送せず送信履歴を確認してください。':s.error?(errors[s.error]||'返信先・認証・通信状態を確認できません。送信していません。'):s.phase==='ready'?'プレビューと添付を確認し、チェックを入れてから最終送信してください。':'本文を編集してプレビューしてください。返信元を変えても本文は保持されます。';
      q('[data-reply-status]').textContent=message;
      q('[data-reply-preview-box]').hidden=!s.preview;
      q('[data-reply-confirm]').checked=s.confirmed;q('[data-reply-confirm]').disabled=sending;q('[data-reply-send]').disabled=!state.canSend();
      if(s.preview){const p=s.preview;q('[data-reply-preview-meta]').textContent=`To: ${p.recipient} / CC: ${p.cc_addresses.join(', ')||'なし'} / 件名: ${p.subject}`;
        if(renderedToken!==p.confirmation_token){q('[data-reply-frame]').srcdoc=p.html;renderedToken=p.confirmation_token;}
        q('[data-reply-preview-files]').innerHTML=p.attachments.map(a=>`<li>${escape(a.filename)}（${Math.ceil(a.size/1024)} KB）</li>`).join('');
      }else if(renderedToken){q('[data-reply-frame]').removeAttribute('srcdoc');renderedToken=null;}
      const h=s.history;q('[data-reply-history-result]').innerHTML=!h?'':h.loading?'<p>送信履歴を読取確認中…</p>':h.error?'<p>履歴を取得できませんでした。UNKNOWNは解除せず、再送しないでください。</p>':`<h3>保存済み送信記録・Gmail履歴</h3><p class="hint">読取確認です。同期・確認済み化・再送は行いません。</p>${h.messages.map(m=>`<p>${escape(m.sent_at||'日時未取得')} ${escape(m.subject||'')} / ${escape(m.gmail_message_id)}</p>`).join('')||'<p>取得範囲に送信記録なし。未送信の証明ではありません。</p>'}<p>監査記録 ${h.audit.length}件 / ${escape(h.status||'取得状態未確認')}</p>`;
    });
  }
  return {mount,detach(){detach();}};
}
