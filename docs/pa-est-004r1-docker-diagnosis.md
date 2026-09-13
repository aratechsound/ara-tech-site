# PA-EST-004R1 Docker Desktop 起動障害 READ-ONLY 診断

診断日: 2026-09-13 JST。修復、削除、rename、Docker起動・停止、WSL変更、service変更は実施していない。

## 確定事実

- Windows 11、build 26200、x64。
- Docker Desktop 4.85.0（binary `4.85.0.235549`）がユーザープロファイル配下にインストール済み。
- Docker CLI client 29.6.2は応答するが、server/daemonは応答しない。
- 調査時点でDocker process、Docker serviceとも稼働なし。
- `wsl --list --verbose` では `docker-desktop` のみ存在し、Stopped / WSL2。
- ローカルPostgreSQL service/process、5432・54320・54321・54322 listener、PATH上の`psql`はいずれも確認できない。
- `C:\Users\user\AppData\Local\Docker\run\dockerInference` は0 byte、非directory、`Archive, ReparsePoint`。作成 2026-08-05 11:00:42、最終更新 2026-08-09 23:03:38。
- このreparse objectはACL取得がOS error 1920で失敗し、`fsutil reparsepoint query` も「システムはファイルにアクセスできません」で失敗する。
- backend logは2026-09-09 03:50:12Zと2026-09-13 01:59:17Zに、Inference manager初期化時の同一失敗を記録。`dockerInference` の除去時にアクセス不能／path syntax failureとなり、Desktopがunexpected errorで終了している。

## 判定

`DOCKER_CAUSE_CONFIDENCE=HIGH_FOR_FAILURE_LOCATION`。起動失敗箇所と、対象endpointの不正または破損したreparse metadataは確認できた。ただし、そのmetadataが不正になった原因までは確定していないため、「単なる残骸ファイルが唯一の根本原因」とは断定しない。

Docker修復をせず利用可能な複数connection PostgreSQLも見つからなかった。このため `MULTIPLE_CONNECTION_DB_RACE=BLOCKED_ENVIRONMENT`。PGlite単一接続でのtransaction/lock/unique試験は実施したが、多接続競合試験の代替PASSにはしない。

## 所有者承認後の最小修復案

1. Dockerが完全終了しprocessがないことを再確認する。
2. exact target `C:\Users\user\AppData\Local\Docker\run\dockerInference` だけを、同じ`run` directory内のtimestamp付きbackup名へrenameする。削除しない。
3. rename自体がOS error 1920で失敗する場合は、そのexact objectだけを対象にする最小の管理者権限操作を別途承認する。
4. Docker Desktopを1回だけ起動してserver応答を確認する。
5. 成功時もbackupを一時保持する。失敗時は、OSが許す場合だけ元のexact nameへ戻す。

理論上の対象はlocal transient IPC endpointであり、volume/image/WSL distribution resetは不要。ただし、現状のreparse objectはOSから読めないため、rename・復元可能性は未確認で、完全可逆とは表現しない。

`DOCKER_REPAIR_EXECUTED=NO`。所有者の別承認待ち。
