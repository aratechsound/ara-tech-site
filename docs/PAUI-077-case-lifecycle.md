# PAUI-077 — CASE DESKの整理・手動終了

Base: `9d9473edce4528300667aefb0a7161fe294a3142` (Production参照Source)。main・他の候補ブランチは変更しない。

概要末尾に「不要案件の整理」を置き、全7種別で既存の論理削除UI/APIを使う。理由4種類・確認チェック＋最終確認・監査・復元経路は維持。確認対象は案件名・顧客名・受付番号で表示する。

PA_EVENTでは、その直前に「案件の終了処理」を設ける。見送り／取消／対応終了はそれぞれ既存のdeclined／cancelled／closedを保存する。正式確認・受注・請求・入金・未処理商務があれば通常終了は拒否する。イベント日付からの終了判定は追加しない。既存のisClosedCaseと一覧フィルターを使う。

通常終了は既存のupdate_pa_case_progress RPCにmanual_close_status分岐を追加する。案件行を先にロックし、status/revision/updated_at・進捗updated_atを照合した後、同一トランザクションで商務記録を検査する。状態保存・進捗同期・既存監査に加えmanual_case_closed監査を残す。既存署名・ACL・is_work_adminと通常の進捗更新本文は保持する。

入金完了はOwnerの明示確認後のみ。V5請求があれば既存close_case→pa_v5_payment_and_closeをnew_payment_minor=0で使用する。保存済み入金・調整額と請求額・最終精算額の一致、商務の履行・精算確認を満たす場合だけ導線を有効にする。請求がない従来案件は既存recordOwnerPaidCompletionを再利用する。後者でV5請求・入金記録を迂回できないよう、同じRPC内にも保護を追加する。入金額・日付・方法は生成しない。

保存はダイアログ内で1回のみ。失敗・競合・結果不明時は再送不可とし、現在の保存状態を読戻す。成功時も案件状態と進捗のclose_reason/closed_atを読戻してから一覧へ反映する。顧客メール・Gmail同期は呼ばない。

## 本番反映ゲート

`ops/PAUI-077-manual-close-CANDIDATE.sql` はローカル検証済みの関数更新候補であり、本番未適用。別途Owner承認後、対象DB・現行関数定義とACL・Sourceをfresh照合する。独立して変更された関数を上書きしない。SQL適用とSource公開の両方が必要。新UIだけを先行公開すると通常終了RPCは未対応のため失敗停止する。現在のProduction・実顧客状態は本Taskで変更しない。

## 検証

`node tests/validate-paui077-case-lifecycle.cjs`。既存PGlite fixtureで実RPC・権限・監査・競合・実V5残高ガード・入金記録不増を確認。ブラウザーではPC/モバイル、全7種別の最下部配置・確認対象・二段階確認キャンセル・結果不明時再送不可を確認する。旧UIは開かない。

`/tests/paui077-preview.html` は既存の合成Preview方式を再利用した架空データ専用画面。integrationを置換し、保存・API・外部通信を拒否する。終了・ゴミ箱の見た目と確認手順を確認できるが、保存成功や本番DB適用の証拠ではない。
