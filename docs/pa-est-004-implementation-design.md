# PA-EST-004 実装設計

## R1差分

- forward migration `20260913130000_pa_case_management_v5_r1.sql`を追加。発行済みmigrationは書換えない。
- 送信済み見積のdelivery evidenceと訂正をappend-only化。Gmail binaryはserverがcase/message/attachment固定で取得し、browserから任意byteを渡さない。
- 同一正式受注確認の再案内は、元の暗号化secret envelopeを複製して同じoffer/token identityを使う。新しいtokenを発行しない。
- 成立後変更は`change_order` seriesの提案・送信・明示的合意として分離し、成立済みcontractとpre-contract currentを上書きしない。
- Composer CCはthread participant allow-list、preview token、outbox reply binding、MIME `Cc`まで固定。
- outbox claimは送信直前にcurrent/token/change proposalを再検証し、stale jobをtransportへ渡さずcancelする。
- adapter成功後のDB応答喪失はprovider message identityのreadbackでsent確定を復旧し、未確定ならunknownへ止める。期限切れworker leaseは同じjobを再claimする。
- 成立後・請求前の手動前払いを既存payment ledgerへappend-only記録し、訂正も追記する。後の請求作成transaction内triggerでpaymentをbillingへ結び、全額前払いでも実施・精算・請求が揃うまで完了しない。
- clientのoperation IDとdocument/offer IDを同一draftの再試行で保持し、serverは同一operationのpayload差替えを拒否する。

## 状態と不変条件

- `pa_estimate_revisions` と `pa_commercial_documents` は発行後の原本を更新せず、caseごとの版番号とSHA-256で保持する。
- `pa_case_commercial_state.current_estimate_revision_id` が現在版を一意に指す。楽観revisionとcase row lockを併用する。
- 改訂開始は、未承認tokenの失効、outbox取消、state切替、auditを同一transactionで行う。成立済みcontractがあれば通常改訂を拒否する。
- 正式受注確認は現在の見積revision、offer、hash化token、snapshot、outboxを一括発行する。準備中はtokenを作らない。
- acceptはtoken、offer、snapshot digest、現在版、期限、PDF hashを再検証する。accepted replay以外のterminal tokenを拒否する。
- outboxは不変の宛先・本文・添付identityを持つ。lease付きclaimで直列化し、結果不明は `unknown` のまま人の照合まで止める。
- 請求は `separate_pdf` と `no_separate_invoice` を分離する。どちらも金額、期限根拠、先方予定日を保持する。
- 入金は追記型で、訂正は削除せず反対調整を追加する。全額・業務完了・精算完了・請求条件をlock下で再検証してから入金追加と完了を一括確定する。
- 再開は契約、原本、請求、入金を残し、理由とoperation identityをauditへ残す。

## schema/API差分

Migration `20260913110000_pa_case_management_v5.sql` は、商取引原本、見積revision、case商取引state、outbox、billing、payment adjustment、change-order台帳を追加し、既存payment tableを複数入金へ拡張する。新RPCは改訂開始、見積発行、確認発行／単独件別失効、outbox claim/finish、実施精算確認、請求、入金、訂正、完了、再開を担当する。

HTTP層はVercel Function上限12本を維持するため、`/api/pa-mail?surface=commercial` に統合した。admin認証、origin、rate limit、action allow-list、no-storeを適用する。確認URLはAES-256-GCM envelopeとしてprivate outboxにだけ保存し、APIログへ出さない。

共通Composerは通常返信、見積、請求、正式受注確認案内を切り替える。切替時に本文、宛先、添付、返信sourceを初期化しない。商取引3モードは最終確認後だけV5発行RPCとoutbox dispatchへ進む。

## 既知の未完

- change-orderは台帳schemaまで。proposal/agreement/billing application用RPCと管理UIは未実装。
- 請求書PDFの自動生成は未実装。所有者が用意したPDFの検証・登録・送信に対応する。
- Production migration ledger、実Gmail、Productionデータ、別プロセスのPostgreSQL複数connection競合は未確認。
