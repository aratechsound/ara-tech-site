# 開催予定イベント半自動登録（Codex運用）

## 目的と境界

代表から「2026年8月14日、BURK、Club L2、PA担当。開催予定に追加」のような短い指示を受け、Codexが公式情報の調査、掲載候補の生成、公開前レビューまで進める。レビュー表示後の明示承認があるまで、本番DB・Storage・管理画面には一切書き込まない。

最初の依頼に含まれる「追加」「登録」は公開承認ではない。候補ハッシュ付きの公開予定内容を表示した後、別のユーザーメッセージで「OK」「公開して」「それでいい」等を受ける必要がある。

## 1. 調査ブリーフを作る

```powershell
node scripts/add-upcoming-event.mjs init --instruction "2026年8月14日、BURK、Club L2、PA担当。開催予定に追加"
```

`work/upcoming-events/<workflow-id>/` に以下を作る。このディレクトリはGit・Vercelの対象外。

- `request.json`: 自然言語から抽出した最小入力
- `research.json`: 公式調査結果の入力用テンプレート
- `research-checklist.md`: Codex向け調査順序

## 2. 公式情報を調査する

優先順位は、会場公式Web、主催者公式Web、アーティスト公式Web、公式Instagram／SNS、その他の明確な公式情報。第三者まとめサイトや検索スニペットだけを本番公開根拠にしない。

最低でも日付、会場、アーティスト／イベント名を公式情報で照合し、`research.json` の `official_sources[].confirms` に記録する。情報が不一致なら `conflicts` に記録し、勝手に解決しない。

画像探索は次の順序で行う。

1. `img src`
2. `srcset`
3. OGP画像
4. ページ内JSON / JSON-LD
5. 公開APIレスポンス
6. DOM解析
7. ブラウザNetwork解析
8. 実表示に対応する公開CDN URL

CAPTCHA、認証、アクセス制御、ログイン保護等に当たったら回避せず、画像だけ `human_action_required` とする。画像取得失敗はイベント候補作成を止めない。

画像の `usage_permission` が `confirmed` でない限り、取得に成功しても公開ペイロードには含まれない。外部画像を無断でARA-TECH Storageへ再ホストしない。

## 3. 公開前候補を作る

```powershell
node scripts/add-upcoming-event.mjs prepare `
  --request work/upcoming-events/<id>/request.json `
  --research work/upcoming-events/<id>/research.json
```

`candidate.json`、`review.md`、`state.json` が作られる。正常時の状態は `PUBLICATION_PENDING_APPROVAL`。この段階のDBペイロードは必ず `is_published: false` であり、CLIはネットワーク接続も本番更新も行わない。

`review.md` の全文を代表へ表示し、「この内容で公開してよいか」を確認して停止する。

## 4. 修正する

文章や担当表記などの修正は、対象セクションだけをJSONパッチにして適用する。

```powershell
node scripts/add-upcoming-event.mjs revise --candidate <candidate.json> --patch <patch.json>
```

修正すると候補ハッシュが変わり、以前の承認は無効になる。日付、タイトル、出演者、会場、公式URLを変えた場合は `RESEARCH_RECHECK_REQUIRED` になり、公式情報の再照合が必要。

## 5. 明示承認後だけ公開用ペイロードを出す

代表がレビュー後に明示承認したターンでのみ実行する。

```powershell
node scripts/add-upcoming-event.mjs approve --candidate <candidate.json> --approval "OK"
node scripts/add-upcoming-event.mjs export --candidate <candidate.json> --approval-file <approval.json>
```

承認は候補SHA-256に紐づく。候補が1文字でも変わると `export` は失敗する。`export` 自体も本番更新を行わず、承認済み `publication-payload.json` を作るだけ。

本番DBの `announcement_confirmed_on` には、Codexの調査日ではなく、公式リンクを含む候補を代表が承認した日を設定する。

## 6. 既存管理画面で公開する

承認済みペイロードだけを、既存の認証済み `https://ara-tech.cc/admin.html` へCodexが入力する。

- 状態は「開催予定」
- 公開方法は「今すぐ公開」または代表が承認した予約日時
- 画像は `image_upload` が存在し、利用確認済みの場合だけ既存Storage経路でアップロード
- slugの重複を管理画面で確認
- slug重複で公開URL案を変える必要がある場合は、候補を修正して新しいURL案を再表示し、再承認を受ける
- サービスロールキーや認証回避は使わない

## 7. 公開後確認

詳細ページのHTTP 200、表示内容、画像、title、canonical、OGP、Event構造化データ、sitemap、公式リンク、モバイル表示を確認する。加えて既存の開催予定2件を回帰確認する。いずれかが未確認なら成功扱いにしない。

## DBへの対応

OPEN / START、画像取得状態、画像取得元は調査・承認成果物に保持する。現行 `work_posts` に専用列は追加せず、OPEN / STARTは掲載文章へ反映し、画像は既存 `work-flyers` Storage、その他は既存列へ対応付ける。これによりPhase 1のDB・管理画面・SEO・sitemap実装をそのまま再利用する。
