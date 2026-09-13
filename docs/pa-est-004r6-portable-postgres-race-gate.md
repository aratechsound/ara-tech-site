# PA-EST-004R6 Portable PostgreSQL独立競合試験

## 判定

- `RESULT=PASS_LOCAL_RELEASE_GATE`
- `MULTIPLE_CONNECTION_DB_RACE=PASS`
- `LOCAL_RELEASE_GATE=PASS`
- `OWNER_ACCEPTED_UI=YES`
- UI基準commitは `1e22fefa8d3f1e61f91ed5ea8f6ee07f409b8b3d`。R6ではUIを変更していない。
- DockerはPA案件管理Release Gateから分離し、R6では起動・変更していない。R4/R5 backupを保持した。

## PostgreSQL環境

repository、Supabase metadata、既存docsをREAD-ONLY検索したが、Production PostgreSQL majorの信頼できる既存証拠はなかった。安全な認証済みProduction SQL Editor sessionも利用しなかったため、Productionへ接続せず `select version()` は実行していない。

- Production version: `UNKNOWN`
- Test version: PostgreSQL 17.11, 64-bit Windows build
- Version match: `UNKNOWN`
- Source: PostgreSQL公式Windows downloadが案内するEDB Windows x86-64 binary ZIP
- Download: `https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip`
- Local downloaded ZIP SHA-256: `4B8DB0930C38F6EF845DB919551DEDDA3B6B845AEB0927B3D79A6E8E9E4537CF`
- 配布元がこのarchive用の検証可能なchecksum/signatureを提示していないため、上記は取得ファイルのローカルhashであり、外部公表hashとの一致を称さない。

専用root `C:\Users\user\Documents\Codex\2026-09-13\pa-est-004-postgres-race-gate` のみを新規使用した。ZIPの5006 entryについてabsolute path、親移動、drive prefix、重複entryを検査し、不正entry 0を確認してから展開した。`initdb.exe`、`pg_ctl.exe`、`psql.exe`、`createdb.exe`、`postgres.exe` をabsolute pathで使用した。

専用clusterはrandom test-only superuser password、SCRAM、`127.0.0.1:55432`、専用`pgdata`で初期化した。server readbackはPostgreSQL 17.11、port 55432、listen address 127.0.0.1、専用data directoryだった。Windows service、PATH、registry、firewall、WSL、Docker、管理者権限、Production credentialは使用していない。

## 検出した競合不具合と修正

初回の実競合で、同一payment operationの2 sessionがともlock前の冪等性SELECTを実行し、待機側がwinner commit後にINSERTへ進んで `pa_payment_records_operation_id` unique violationとなる問題を検出した。

forward migration `20260913170000_pa_case_management_v5_payment_race.sql` で、`pa_v5_record_payment` が案件行を最初にlockし、その後の新しいstatement snapshotでoperation identityとpayloadを再確認するよう修正した。既存のglobal unique constraint、payload mismatch拒否、billing lock、payment/auditの同一transaction性は維持した。

Harnessでは、loserが期待どおりRPC内でraiseしてpost-operation markerへ到達しない場合をunhandled promise rejectionにしないよう、Aのlock markerを同期gateとして必須のまま維持し、BはBEGIN/backend identity/exit rollbackを記録するよう修正した。全scenarioに明示的なinvariant、duplicate count、timeout/deadlock、statusを保存する。

## 独立session試験

`tests/validate-pa-est-004-r2-postgres-races.mjs` を全10 scenarioについて最初から再実行した。各A/Bは別々の`psql.exe` process、別々の`pg_backend_pid()`であり、Aがtransaction内でlockを保持している間にBを開始した。`lock_timeout=5s`、`statement_timeout=12s`、process timeout=15sを設定した。

| Scenario | Session A PID | Session B PID | 結果 | 最終invariant |
|---|---:|---:|---|---|
| accept first vs revision | 24728 | 45500 | PASS | accepted 1、token accepted、revision audit 0 |
| revision first vs accept | 45884 | 2096 | PASS | accepted 0、token revoked、revision/revoke audit各1 |
| accept vs single revoke | 45232 | 30388 | PASS | accepted 1、token accepted、revoke audit 0 |
| current estimate switch | 41724 | 13944 | PASS | winnerだけcurrent、loser document 0 |
| confirmation issue | 42344 | 19328 | PASS | offer/active token/audit各1、loser offer 0 |
| same payment operation retry | 28996 | 14284 | PASS | payment 1、audit 1、両session commit |
| different payment registrations | 25368 | 43764 | PASS | payment 2、合計50000、audit 2 |
| outbox concurrent claim | 11748 | 45704 | PASS | processing lease 1、attempt 1 |
| expired lease recovery | 44620 | 34332 | PASS | replacement lease 1、attempt 2 |
| transaction failure / rollback | 38076 | 3964 | PASS | rollback row 0、competitor row 1、audit 1 |

全scenarioでlock待機を観測し、A/B PIDは相違、重複0、timeout/deadlockなし。詳細なtransaction marker、commit/connection-exit rollback、最終DB state、auditは次に保存した。

`C:\Users\user\Documents\Codex\2026-09-13\pa-est-004-postgres-race-gate\evidence\pa-est-004-r2-postgres-race-evidence.json`

## 回帰と停止

schema修正後、R1 DB/RPC、HTTP/outbox、CC、formal confirmation 29/29、Composer 7/7 + 7/7、base DB/API/service/static、送信済み見積復旧、change order、billing/payment、PA portal、Stage Plot、Function count 12、実管理画面browserを再実行し、すべてPASSした。browserはfreshなlocalhost fixture、PGlite、fake adapterで実行し、外部request 0を確認した。

証跡保存後に`pg_ctl stop`でportable serverを正常停止した。停止readbackはpostgres process 0、port 55432 listener 0。test-only credential一時ファイルは削除済みで、binaries、pgdata、logs、evidenceはProduction Release Auditまで保持する。
