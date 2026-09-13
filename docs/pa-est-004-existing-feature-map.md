# PA-EST-004 既存機能対応表

基点は `9764c0a71f6bddc562b4de6f1bd6dbb1011b69e6`。既存機能を削除せず、V5の商取引状態を追加した。

| 既存項目 | 現行実装の根拠 | 新しい表示先 | 扱いと理由 | 回帰証跡 |
|---|---|---|---|---|
| 14工程・案件進捗 | `js/pa-admin.js:63`, `supabase/migrations/2026-07-24-pa-case-progress.sql:18` | 上段「現在の状況」＋従来の工程詳細 | 維持。工程番号だけで完了率を推定しない | PA回帰群 |
| 請求・手動入金・完了 | `supabase/migrations/2026-07-24-pa-case-progress.sql:56`, `:512` | 見積・請求カード／従来の精算欄 | 既存テーブルを拡張。複数入金と訂正を追加 | `validate-pa-est-004-db.cjs` |
| Gmail thread返信 | `js/pa-admin.js:420`, `:2984` | 共通Composer | 維持し4モードへ拡張。選択中の本文・添付・返信先を保持 | `validate-pa-r2-preview-body-binding.cjs` |
| Gmail直接送信見積の復旧 | `js/pa-admin.js:3359` | 見積カード | 再送しない `sent_recovery` として追加 | DB/static試験 |
| 正式受注のoffer/token/contract | `supabase/migrations/20260907130000_pa_formal_contract.sql:3`, `:16`, `:21` | 正式受注確認カード | 再利用。offerに見積revisionを結合しacceptを強化 | `validate-pa-contract.cjs`, V5 DB試験 |
| 連絡先・案件メモ・工程・監査 | `pa-admin.html` の既存詳細領域 | 上段の下に従来どおり | 削除・置換なし | Previewとsource確認 |
| 資料ポータル | `pa-admin.html:177`, `js/pa-admin.js:908` | 関連資料の下に既存導線 | 本体変更なし | portal回帰群 |
| ゴミ箱・purge | `js/pa-admin.js:2544` | 従来の管理領域 | 維持。V5保全データがあるcaseの物理削除をDB guardで拒否 | static/DB確認 |
| Stage Plot Editor | 既存の案件導線 | 従来位置 | 本体変更なし | Function数・Stage Plot回帰 |

廃止した機能はない。旧 `pa_contract_issue` は新しい見積版固定を迂回するため、service roleからの実行権だけを外した。Production適用前にlegacy利用箇所の再照合が必要。
