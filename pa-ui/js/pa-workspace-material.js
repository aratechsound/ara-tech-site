import {privateFrame,privateText,resetPrivacy} from './pa-workspace-privacy.mjs';
export async function showPrivateDocument(blob,filename){
 resetPrivacy();const dialog=document.createElement('dialog');dialog.className='pa-material-preview-dialog';
 const title=document.createElement('h3');title.textContent=privateText(filename||'原本資料');
 const note=document.createElement('p');note.textContent='資料内の金額を含む原本は、明示表示時のみ表示します。30秒・非アクティブ時に再非表示。';
 const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.style.cssText='width:100%;height:65vh;border:0';
 const url=URL.createObjectURL(blob);privateFrame(frame,'src',url);
 const close=document.createElement('button');close.type='button';close.textContent='閉じる';close.onclick=()=>dialog.close();
 const download=document.createElement('button');download.type='button';download.textContent='原本をダウンロード';download.onclick=()=>{const a=document.createElement('a');a.href=url;a.download=filename;a.click();};
 dialog.append(title,note,frame,close);dialog.addEventListener('close',()=>{resetPrivacy();URL.revokeObjectURL(url);dialog.remove();},{once:true});document.body.append(dialog);dialog.showModal();
}
export function createMaterialPreview({filename,previewRoot,card,getBlob,isCurrent}){
 previewRoot.textContent='原本プレビュー（非表示）';let pending=false;
 card.addEventListener('click',async()=>{if(pending||!isCurrent())return;pending=true;try{const blob=await getBlob();if(isCurrent())await showPrivateDocument(blob,filename);}catch{previewRoot.textContent='原本を取得できません。権限と案件の紐付けを確認してください。';}finally{pending=false;}});
}
