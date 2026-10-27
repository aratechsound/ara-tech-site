'use strict';
const assert=require('node:assert/strict');
// PAUI-083 closes the composer only for a matching, durable SENT result.
// Keep recovery tests bound to both closure and the case-scoped outcome.
module.exports=async function assertCaseMailSent(page,dialog,{historyUnconfirmed=false}={}){
 await dialog.waitFor({state:'detached'});
 const status=page.locator('[data-case-mail-status]');
 await status.getByText(historyUnconfirmed?'Gmail送信済み／履歴未更新。再送不要です。保存済み送信結果の照合が必要です。':'Gmail送信済み',{exact:true}).waitFor();
 assert.equal(await status.getAttribute('role'),historyUnconfirmed?'alert':'status');
 assert.equal(await page.getByRole('dialog',{name:'CASE DESKメール作成',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'最終確認してGmail送信',exact:true}).count(),0);
};
