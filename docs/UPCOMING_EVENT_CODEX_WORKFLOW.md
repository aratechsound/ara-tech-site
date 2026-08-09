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
- 確認用画像と一般公開画像は分離する
- フライヤーを確認した代表が「このフライヤーを公開ページに掲載する」をONにして保存すると、明示確認を監査記録へ残し、認証済みAPIが同じ公式画像を検証して既存 `work-flyers` Storageへコピーする
- チェックがOFFなら確認用画像だけを管理画面に表示し、一般公開ページは画像なしにする。コピーや整合性確認に失敗した場合は保存・公開へ進まない
- 画像掲載のON/OFF、Storage上の画像、取得元または画像ハッシュが変わると候補ハッシュが更新され、以前の承認は無効になる
- 「見送り」は候補だけを非公開のまま見送りにし、既存公開実績は削除しない
- サービスロールキーや認証回避は使わない

## 6. 管理画面から明示承認して公開する

最終内容をプレビューした代表が「公開する」を押し、確認ダイアログに同意した操作だけを承認とする。公開RPCは画面が送った候補SHA-256とDBの最新SHA-256を照合し、一致しない場合は公開しない。成功時に `approved_hash`、承認者、承認日時を記録し、その同じ行を公開状態へ変更する。

本番DBの `announcement_confirmed_on` には、この最終公開操作の日を設定する。

## 7. 公開後確認

詳細ページのHTTP 200、表示内容、画像、title、canonical、OGP、Event構造化データ、sitemap、公式リンク、モバイル表示を確認する。加えて既存の開催予定2件を回帰確認する。いずれかが未確認なら成功扱いにしない。

## DBへの対応

OPEN / START、SEO、候補ハッシュ、承認ハッシュ、確認用画像URL、画像取得方法、画像利用確認状態、公開画像ON/OFF、公開画像の取得元・SHA-256・明示確認者・確認日時を `work_posts` に保持する。一般公開画像は従来どおり既存 `work-flyers` Storageを使用し、代表が公開画像を明示選択した場合だけ認証済み経路でコピーする。選択・再確認・解除は `work_candidate_image_audit` に追記する。
