# PA-EST-004R2 Docker最小修復提案（未実行）

## 判定

`DOCKER_REPAIR_REQUIRED=YES`。安全に利用できる通常PostgreSQL環境がほかに見つからず、複数接続競合試験にはDocker上の隔離PostgreSQLが現実的な経路である。ただし、根本原因は確定していない。以下は所有者の別承認を得た後にだけ実行する提案であり、今回は一切実行していない。

## 対象と現在のmetadata

- 操作対象: `C:\Users\user\AppData\Local\Docker\run\dockerInference`
- 種別: non-directory ReparsePoint
- `Length`: 0 byte
- `Attributes`: `Archive, ReparsePoint`
- `CreationTime`: `2026-08-05 11:00:42 +09:00`
- `LastWriteTime`: `2026-08-09 23:03:38 +09:00`
- `LinkType`: 空欄
- `Target`: 空欄
- ACL/reparse queryの既知結果: OS error 1920
- 提案作成時のDocker process: なし
- rename先: `C:\Users\user\AppData\Local\Docker\run\dockerInference.pa-est-004r2-backup-20260913-001`
- rename先の提案時存在確認: 不存在

## 提案する一回限りの操作

事前にDocker Desktopおよびbackend processが停止していることと、上記metadataが変化していないことを再確認する。不一致なら何も変更せず停止する。

```powershell
$ErrorActionPreference = 'Stop'
$repairTarget = 'C:\Users\user\AppData\Local\Docker\run\dockerInference'
$repairBackup = 'C:\Users\user\AppData\Local\Docker\run\dockerInference.pa-est-004r2-backup-20260913-001'
$dockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

$running = Get-Process -Name 'Docker Desktop','com.docker.backend','com.docker.build','vpnkit' -ErrorAction SilentlyContinue
if ($running) { throw 'Docker processes are running; no change made.' }
if (Test-Path -LiteralPath $repairBackup) { throw 'Backup destination already exists; no change made.' }
$item = Get-Item -LiteralPath $repairTarget -Force
if ($item.PSIsContainer -or $item.Length -ne 0 -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'dockerInference metadata changed; no change made.'
}

Rename-Item -LiteralPath $repairTarget -NewName 'dockerInference.pa-est-004r2-backup-20260913-001'
Start-Process -FilePath $dockerDesktopExe -WindowStyle Hidden
```

- backup方法: 対象を同一volume・同一directory内でrenameして保持する。内容を読み取れない可能性があるためcopyではない。
- Docker起動回数: 1回だけ。起動失敗時の自動／手動retryは行わない。
- 起動後確認: 最大120秒の範囲でprocess/backend状態と `docker version` をREAD-ONLY確認する。CLIとServerの両方が応答し、新しいInference初期化errorが出ないことを成功条件とする。

## 成功・失敗判定

成功は、(1) rename先が保持され、(2) Docker backendが起動し、(3) `docker version` がServer情報を返し、(4) `dockerInference`初期化errorが再発しない、の全条件である。その後もR2競合試験がPASSするまではRelease GateをPASSにしない。

失敗は、renameがOS error 1920等で完了しない、Docker Desktopが120秒以内にbackendを提供しない、同じInference manager errorが再発する、または別のbackend errorになる場合である。失敗時は再起動・削除・ACL変更・再installへ拡張せず停止する。

## Rollbackとrisk

- rename自体に失敗した場合は変更なし。
- rename成功後、Dockerが元pathを新規作成していない場合は、Docker process停止を確認してからbackup名を元名へrenameできる。
- Dockerが元pathを再作成した場合、その新規pathを削除・上書きしない。両方を保存して停止し、追加承認を求める。
- corruptなreparse metadataが原因でbackup側も操作不能となる可能性があり、rollback可能性は保証できない。
- image、container、volumeの保存領域は操作対象外であり、削除しない。Factory Reset、Clean/Purge、再install、WSL unregister、run folder全体削除、PC再起動、ACL全体変更、diagnostics外部送信も実行しない。
- volume/containerへの直接影響は想定しないが、Docker backendの一回起動に伴う通常のruntime metadata更新は起こり得る。
- データ消失riskは低いがゼロではない。対象一点のrenameがDocker内部状態にどう解釈されるか未確定のためである。
- 管理者権限: 通常権限でrename可能か未確定。Access deniedまたはOS error 1920になった場合もACLを変更せず停止する。管理者PowerShellで同一の一点renameを行うには、所有者の追加確認が必要。

## 禁止事項

`dockerInference`を削除しない。Reset to factory defaultsは実行しない。Clean/Purge、Docker再install、WSL unregister、volume/image/container削除、run folder全体削除、PC再起動、ACL全体変更、diagnostics外部送信を行わない。
