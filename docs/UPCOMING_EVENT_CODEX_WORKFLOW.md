# 開催予定イベント半自動登録（Codex運用）

## 目的と境界

代表から「2026年8月14日、BURK、Club L2、PA担当。開催予定に追加」のような短い指示を受け、Codexが公式情報の調査、掲載候補の生成、認証済み管理画面の「公開待ち」への登録まで進める。公開待ちデータは非公開で、代表が管理画面の「公開する」を実行するまで一般公開しない。

最初の依頼に含まれる「追加」「登録」は公開承認ではない。最終承認は、認証済み管理画面に表示された候補を確認し、確認ダイアログを経て「公開する」を実行した操作だけとする。

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

### OPEN / STARTの厳格な扱い

`OPEN` は公式情報で「OPEN」または「開場」と明示された入場開始時刻だけ、`START` は「START」または「開演」と明示された公演開始時刻だけ、`CLOSE` は「CLOSE」「END」「終演」等と明示された終了時刻だけを登録する。`official_sources[].confirms` の同じ公式ソースに、`open_time` と `open_time_label: "OPEN"`、`start_time` と `start_time_label: "START"`、または `close_time` と `close_time_label: "CLOSE"` を記録できた場合だけ公開候補へ渡る。

`22:00 - 04:00` のような営業時間・開催時間帯は、それだけではOPEN / START / CLOSEを意味しない。明示ラベルがなければ時刻欄を空欄のままにする。`CLOSE` / `END` の明示時刻はCLOSE欄に保存し、終了時刻をSTART欄へ保存しない。CLOSEの24時超表記（`25:00`等）は翌日1:00へ変換せず、原表記のまま保持する。

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

調査内容を確認後、既存の認証と権限を使って候補を `work_posts` の `publication_review_status = PUBLICATION_PENDING_APPROVAL` として登録する。一般公開一覧・詳細・sitemapには出ない。レビュー用外部画像は `review_image_url` に保持し、利用確認済みでない限り `use_image_on_public_page = false` とする。

## 4. 修正する

文章や担当表記などの修正は、対象セクションだけをJSONパッチにして適用する。

```powershell
node scripts/add-upcoming-event.mjs revise --candidate <candidate.json> --patch <patch.json>
```

管理画面またはCLIで修正すると候補ハッシュが変わり、以前の承認ハッシュ・承認者・承認日時はDBトリガーにより無効になる。日付、タイトル、出演者、会場、公式URLを変えた場合は公式情報を再照合する。

## 5. 既存管理画面でレビューする

認証済み `https://ara-tech.cc/admin.html` の「公開待ち」から候補を開く。

- 「プレビュー」は認証済みAPIから生成され、`noindex`・`no-store` の管理画面内iframeだけで表示する
- 「編集」「保存」で修正し、保存後の新しい候補ハッシュを確認する
- 公開待ち一覧には、公演情報、掲載文章、SEO情報、候補SHA-256と、認証済みAPIが検証したフライヤー画像を表示する
- 代表が一覧の「公開する」を実行した操作を、表示中のフライヤーを含む候補全体の最終承認とする。画像だけの追加承認操作は設けない
- 一覧に表示した画像と同じバイトをブラウザ内に保持し、そのSHA-256を付けて既存 `work-flyers` Storageへ保存してから公開する。取得、整合性確認、Storage保存のいずれかに失敗した場合は公開しない
- 画像を掲載しない場合だけ「編集」で「画像を掲載しない」を選択して保存する。画像差し替えも編集画面から行う
- 画像掲載設定、Storage path、取得元、画像SHA-256、その他の公開内容が変わると候補ハッシュが更新され、以前の承認は無効になる
- 「見送り」は候補だけを非公開のまま見送りにし、既存公開実績は削除しない
- サービスロールキーや認証回避は使わない

## 6. 管理画面から明示承認して公開する

公開待ち一覧の最終内容を確認した代表が「公開する」を押し、確認ダイアログに同意した操作だけを承認とする。フライヤー候補がある場合は、一覧に表示した同一バイトをStorageへ保存する更新を元の候補SHA-256に限定して実行し、更新後の候補SHA-256を公開RPCがもう一度DBの最新値と照合する。一覧表示後に内容が変わっていれば公開せず再確認を求める。成功時に `approved_hash`、承認者、承認日時を記録し、その同じ行を公開状態へ変更する。

本番DBの `announcement_confirmed_on` には、この最終公開操作の日を設定する。

## 7. 公開後確認

詳細ページのHTTP 200、表示内容、画像、title、canonical、OGP、Event構造化データ、sitemap、公式リンク、モバイル表示を確認する。加えて既存の開催予定2件を回帰確認する。いずれかが未確認なら成功扱いにしない。

## DBへの対応

OPEN / START、SEO、候補ハッシュ、承認ハッシュ、確認用画像URL、画像取得方法、画像利用確認状態、公開画像ON/OFF、公開画像の取得元・SHA-256・確認者・確認日時を `work_posts` に保持する。一般公開画像は従来どおり既存 `work-flyers` Storageを使用し、代表が候補全体を「公開する」で承認した場合だけ、一覧表示と同一の画像を認証済み経路でコピーする。選択・再確認・解除は `work_candidate_image_audit` に追記する。
