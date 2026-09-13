# PA-EST-004 所有者レビュー

## R1 実管理画面Preview

起動: `node tests/pa-est-004-real-admin-server.cjs`

入口: `http://127.0.0.1:8766/pa-est-004-real-admin-preview.html`

実際の`pa-admin.html`、`js/pa-commercial-admin.js`、`api/_pa-commercial-handler.cjs`を、毎回作り直すPGlite fixtureとfake adapterへ結線するlocalhost専用harness。Productionの認証・DB・Storage・Gmail設定は使わない。画面上部で「正式受注確認待ち」「成立済み」「一部入金」を切り替えられ、切替時はfixture DBを再作成する。

確認順:

1. 上段3カード、関連資料、メールの順と、既存の案件詳細・連絡先・メモ・工程が残っていることを確認。
2. 回答待ちでは「案内内容を確認」「同じ確認を再案内」「この確認だけを失効」が表示され、新規発行がないことを確認。
3. 「送信済みメールから登録」でPDF候補、送信日時、current/historical、金額・条件確認を確認。
4. 関連資料の実PNGとPDFを開く。
5. 成立済みへ切替え、変更提案PDF→偽送信→根拠付き合意→追加額を含む精算を確認する。請求前の前払いと追記訂正が、後の請求へ引き継がれることも確認する。
6. 一部入金へ切替え、50,000円入金済み・60,000円残額を確認。完了確認dialogで入金日、残額、メモを入力し、完了後の「入金記録を見る」「案件を再開」を確認。
7. 共通ComposerのTo/CC/件名/本文/添付とモード切替を確認。外部宛送信は行わない。

証跡はタスクoutputsの `PA-EST-004R1-real-admin-pending.png`、`PA-EST-004R1-real-admin-partial-initial.png`、`PA-EST-004R1-real-admin-closed.png`、4サイズの `PA-EST-004R1-real-admin-initial-*.png`、`PA-EST-004R1-db-readback-{initial,after}.json`、`PA-EST-004R1-layout-readback.json`。初期状態と操作後は別ファイルにしている。

専用`pa-est-004-preview.html`は多状態の視覚比較用で、実DB/API操作証拠ではない。R1実管理画面Previewを機能確認の正とする。

## 起動

worktreeで次を実行する。

```powershell
$env:NO001_PORT='8765'
& 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tests\local-server.cjs
```

開くURL: `http://127.0.0.1:8765/pa-est-004-preview.html`

画面上部に「デモデータ／本番未接続」があること、宛先が `.invalid` であることを最初に確認する。Production Supabase、Storage、Gmailへは接続しない。

## 確認順

1. シナリオ01〜10を切り替え、見積前、pending、同期不明、成立、実施後、請求2方針、部分入金、完了可能、完了済みを見る。
2. 上段が「見積・請求」「正式受注確認」「現在の状況」の3カードで、その下が関連資料1段、さらに下がメール最新順であることを見る。
3. 返信を開き、To/CC/件名/本文/添付/threadを編集して4モードを往復し、値が残ることを確認する。
4. 正式受注確認は「内容を確認」で戻ると状態が変わらず、最終fake送信でだけ発行されることを見る。
5. pendingで条件変更を開始し、旧pending失効とv2切替が一操作で起きることを見る。
6. 請求tabで2方針、部分入金、誤登録訂正、全額＋完了、再開を確認する。
7. 関連資料を横移動し、全件・検索を開く。詳細を展開して連絡先、メモ、14工程、既存導線が残ることを見る。
8. 幅390pxで「現在の状況」が先頭になることを確認する。

自動取得画像: `PA-EST-004-desktop.png`, `PA-EST-004-mobile.png`（タスクoutputs）。V4は配置の起点だけに使い、ダミー状態を本番仕様へコピーしていない。

承認前にProduction適用、実Gmail、push、merge、deployを行わない。画面確認後もPA-EST-005とrelease reviewが必要。
