# PA-EST-004 テスト結果

実行日: 2026-09-13 JST。全fixtureは架空ID、`.invalid` 宛先。`global.fetch` またはローカルserverで外部通信を禁止した。

## 自動試験

| 層 | コマンド | 結果 |
|---|---|---|
| DB/RPC | `node tests/validate-pa-est-004-db.cjs` | PASS。PGlite PostgreSQL engineでmigrationを適用 |
| HTTP/security | `node tests/validate-pa-est-004-api.cjs` | PASS |
| service/outbox | `node tests/validate-pa-est-004-service.cjs` | PASS。fake transport、重複・unknown抑止 |
| static | `node tests/validate-pa-est-004-static.cjs` | PASS |
| browser | `node tests/browser/pa-est-004-preview.mjs` | PASS。Edge headless、外部resource 0 |
| formal contract回帰 | `node tests/validate-pa-contract.cjs` | 29/29 PASS、外部送信なし |
| Composer回帰 | `validate-pa-managed-send-case-binding.cjs`, `validate-pa-r2-preview-body-binding.cjs` | 各7/7 PASS |
| portal/function/Stage Plot回帰 | PA関連validate群 | PASS。新Functionを内部統合後、12本を維持 |

## 必須ID判定

| ID | 結果 | 根拠／不足 |
|---|---|---|
| ENV-01 | PASS | Previewはlocalhost、`.invalid`、fake表示。browser resourceはlocalhost/blob/dataのみ |
| UX-01, UX-04, UX-05, UX-06, UX-10 | PASS | Preview scenario、取消、既存詳細、unknown表示をE2E確認 |
| UX-02 | PARTIAL | Previewは4モード間の本文・To/CC・添付・thread保持をE2E確認。実管理画面は既存To固定でCC欄なし |
| UX-03 | PARTIAL | 既存case/thread binding 7/7 PASS。複数threadのV5実DB E2Eは未実施 |
| UX-07 | PARTIAL | 20件、PDF Blob、Excel表現、横移動、検索を確認。画像fixtureを使う自動試験は未追加 |
| UX-08 | PASS | 1366x650、940x950、390x844、CSS 200%相当で到達性をE2E確認 |
| UX-09 | PARTIAL | native dialogのfocus/Escape、下書き保護実装。全キーボード順序の自動assertは未実施 |
| SEC-01, SEC-02, SEC-03, SEC-05, SEC-06 | PASS | terminal/current/binding/replayをDB試験。既存formal suite 29/29 |
| SEC-04 | PARTIAL | amount/snapshot/hashのDB検証あり。全改竄組合せは未網羅 |
| SEC-07 | PASS | HTTP admin/auth、RPC revoke/grantと既存RLS suite |
| SEC-08 | PARTIAL | private/no-store、secret envelope、sandbox previewを確認。Production storage policy未確認 |
| TX-01, TX-03, TX-04, TX-05, TX-06 | PASS | transaction rollback、旧pending失効、単独revoke、成立済み保護、operation idempotency |
| TX-02 | PARTIAL | lock/terminal両分岐は検証。別プロセス複数connectionの同時実行なし |
| TX-07 | PARTIAL | old issue ACL除去とpurge guardを確認。Production legacy reconciliation未実施 |
| MAIL-01 | PASS | DB transaction内outbox生成。発行失敗時にjobが残らない |
| MAIL-02 | PARTIAL | failed stateの再claim設計あり。adapter失敗からの全HTTP再試行E2Eなし |
| MAIL-03 | PASS | unknownはclaim拒否し盲目的再送を停止 |
| MAIL-04 | PARTIAL | lease/operation guardあり。成功直後crashの別worker競合は未実施 |
| MAIL-05 | PASS | unknown/processingが改訂・発行を停止、revoked queued jobはcancel |
| MAIL-06 | PARTIAL | schemaはjob kindを区別。再案内UI/RPCは未実装 |
| REC-01, REC-02, REC-03 | PARTIAL | Gmail identity unique、再送なし経路あり。全取込分類のAPI試験は未網羅 |
| REC-04 | PASS | outbound/case/message/attachment identityを必須化 |
| REC-05 | PARTIAL | payment訂正はPASS。誤見積登録の専用訂正フローは未実装 |
| BILL-01, BILL-02, BILL-03, BILL-07 | PASS | 自動請求なし、2方針、期限根拠、未確認表現 |
| BILL-04, BILL-05 | PARTIAL | operation identityと確定期限保持あり。再送／後付け請求書UIは未実装 |
| BILL-06 | PARTIAL | 不明条件を未確定表示。銀行休日カレンダーは実装しない |
| PAY-01, PAY-03, PAY-04, PAY-05, PAY-06 | PASS | 原子的完了、部分／前払い、残額拒否、訂正、再開 |
| PAY-02 | PARTIAL | operation identityとrollbackはPASS。別connection同時登録なし |
| REG-01 | PASS | PA既存回帰群PASS |
| REG-02 | PASS | portal/Stage Plot本体変更なし、各回帰PASS |
| REG-03 | PARTIAL | 過去contract/tokenを変更しない。Production legacy照合は未実施 |

`DATABASE_CONCURRENCY_TESTS` は、同一PostgreSQL engine内のlock/transaction/unique制約まで確認したが、Docker daemonが利用できず複数connectionの実競合を実施していないためPARTIALとする。実GmailとProductionはNOT_TESTED。
