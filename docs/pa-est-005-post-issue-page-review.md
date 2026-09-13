# PA-EST-005 後工程レビュー項目

今回実装したresolver/acceptの安全性を前提に、次回は発行後の顧客／ARA-TECH画面を全面レビューする。

- 既存routeと公開URL fragmentの扱い。生tokenをquery、ログ、analytics、refererへ出さない。
- case ID、対象見積revision、原本SHA-256、offer version、snapshot digestの表示と版固定。
- 「見積内容の了承」と「正式受注の承認」を同じ意味にしない文言。
- active、expired、revoked、superseded、accepted replayの状態別表示。terminal URLからacceptできないこと。
- 顧客と管理者の権限差。private原本、メール、actor、他caseへのIDOR防止。
- 金額、税区分、条件、イベント日、合意した支払期限、請求書を別途発行するかの表示。
- accept後の控えPDF、顧客通知、ARA-TECH通知、delivery失敗／unknownの回復表示。
- 承認済みsnapshotと控えPDFを改訂・訂正・再開で上書きしないこと。
- keyboard、focus、390px、200%、日本語読み上げ、エラー復帰。
- Production E2Eは別承認。実顧客・実メールを使わず、release用架空caseの範囲を明示する。

PA-EST-004ではこの全面デザイン確認を完了扱いにしない。
