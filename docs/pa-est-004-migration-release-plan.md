# PA-EST-004 Migration / Release Plan

## R1 forward-only plan

`20260913130000_pa_case_management_v5_r1.sql`を追加し、既存migrationは書換えない。見積復旧・再案内・変更契約に加え、請求前の前払い台帳と請求作成時の紐付けを同じforward migrationに含める。Production適用には別承認、legacy照合（特に既存のbilling未紐付けpayment）、backup/rollback計画、多接続PostgreSQL競合試験、RLS/ACL再確認、実Gmail限定試験が必要。今回は適用、push、deployを行わない。Docker修復前のため多接続gateは未通過。

この文書は計画のみ。今回Productionへ適用しない。

1. 所有者承認後、ProductionのHEAD、migration ledger、V5対象table/RPC不在、旧 `pa_contract_issue` 呼出元、未照合legacy offer/paymentをread-onlyで再確認する。
2. Production snapshot/backup方針と保守時間を所有者が承認する。migrationを空のcloneへdry-runし、既存migration全適用、ACL、Function数12を検証する。
3. 旧成立contract、active/revoked/expired token、既存paymentを自動推定で埋めない。`estimate_revision_id is null` はreconciliation requiredとして停止する。
4. forward migrationを1回適用する。table/RPC/constraint/index/ACLをread backし、書込み前に期待DDLと照合する。
5. 先にread pathとV5 snapshotを有効化し、次にComposerの商取引modeを切り替える。workerは `PA_MAIL_ADAPTER=gmail` を明示し、outbox keyとpublic originをrelease gateで確認する。
6. 架空のProduction test caseを使う場合も別承認を得る。実顧客、実token、実メール、実入金は使わない。
7. rollbackは破壊的down migrationを行わない。UIを旧経路へfeature-disableし、queued jobを送らず、V5データを保持してforward fixする。unknown jobは照合完了まで維持する。
8. release後は見積→確認→accept→請求2方針→部分入金→完了→再開と、旧portal/Stage Plot/年別完了を監視する。

停止条件: ledger相違、未照合legacy、Function上限超過、RLS/ACL相違、outbox key不備、Gmail thread不一致、unknown job、Production backup未承認。
