# PA-EST-004 所有者レビュー

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
