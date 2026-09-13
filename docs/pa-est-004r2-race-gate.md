# PA-EST-004R2 PostgreSQL競合試験Gate

## 状態

- `OWNER_ACCEPTED_UI=YES`
- `UI_BASE_COMMIT=1e22fefa8d3f1e61f91ed5ea8f6ee07f409b8b3d`
- UIのカード配置、関連資料位置、顧客コミュニケーション位置、操作名称は凍結する。
- PA-EST-005の顧客／ARA-TECH詳細画面の全面デザインは対象外。
- 2026-09-13のfresh-readでは、安全に利用できる通常PostgreSQL server/clientを発見できなかった。そのため実競合試験は未実行であり、PASSではない。

## 発見結果

READ-ONLYで、PATH、標準インストール先、Windows service/process/listener、レジストリのインストール情報、Codex runtime、リポジトリ依存、WSL distributionを確認した。

- `postgres.exe` / `psql.exe` / `pg_ctl.exe` / `initdb.exe`: 未発見
- PostgreSQL Windows service / process: 未発見
- PostgreSQL標準portのlistener: 未発見
- 通常PostgreSQLを提供するNode依存、embedded server、Testcontainers: 未発見
- WSL: 停止中の `docker-desktop` のみ
- Docker CLI: 存在するが、backendは既知の `dockerInference` 初期化障害で利用不可
- PGlite: 既存回帰に使用済みだが、単一接続エンジンのためR2の複数接続Gateには不採用
- Productionまたは共有DB: 探索・接続・使用していない

## Harness

`tests/validate-pa-est-004-r2-postgres-races.mjs` は、通常PostgreSQL上で毎回ランダム名の専用databaseを作り、異なる `psql` processをsession A/Bとして起動する。接続URLやpasswordは標準出力と証跡へ保存しない。localhost以外を拒否し、実行者が disposable cluster であることを明示しない限り停止する。試験後は専用databaseだけを `DROP DATABASE ... WITH (FORCE)` で削除する。

各sessionは `pg_backend_pid()`、transaction開始、operation後のlock保持marker、commit/rollback、経過時間を記録する。BはAがoperationを終えてlockを保持したことを確認してから起動する。`lock_timeout=5s`、`statement_timeout=12s`、process timeout=15sを設定する。

対象は次の9分類（accept/revisionは両順序のため10 scenario）。

1. accept先行 vs estimate revision
2. revision先行 vs accept
3. accept vs dedicated single revoke
4. simultaneous current estimate switch
5. simultaneous confirmation issue
6. same payment operation retry
7. two different payment registrations
8. outbox worker concurrent claim
9. expired worker lease recovery
10. transaction rollback and competing commit

各scenarioの証跡にはsession A/B identity、開始時刻、lock待機観測、commit/rollback、最終DB状態、audit件数、重複行検査を含める。1件でもassertionが失敗すれば全体はFAILとなる。

## 将来の実行方法（Docker修復承認・成功後のみ）

以下は実行例であり、R2の今回実行では走らせていない。Production credentialを設定してはならない。

```powershell
$env:PA_EST_004_RACE_ALLOW_DISPOSABLE_CLUSTER = 'YES'
$env:PA_EST_004_RACE_ADMIN_URL = 'postgresql://postgres:<isolated-local-password>@127.0.0.1:<isolated-local-port>/postgres?sslmode=disable'
$env:PA_EST_004_PSQL_PATH = '<full-path-to-psql.exe>'
$env:PA_EST_004_RACE_EVIDENCE = '<absolute-local-evidence-path>.json'
node tests/validate-pa-est-004-r2-postgres-races.mjs
```

実行前に、接続先がこの試験専用のローカル・disposable PostgreSQL clusterであること、既存案件データがないことを別途確認する。共有DBやProductionには使わない。

## 現在の判定

- `MULTIPLE_CONNECTION_DB_RACE=BLOCKED_ENVIRONMENT`
- `DOCKER_REPAIR_REQUIRED=YES`
- `LOCAL_RELEASE_GATE=BLOCKED_DOCKER_REPAIR_APPROVAL`
- 競合試験が実行されていないため、各race項目をPASSと表記しない。
