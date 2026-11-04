# 開催予定イベント半自動登録（Codex運用）

## 目的と境界

代表から「2026年8月14日、BURK、Club L2、PA担当。開催予定に追加」のような短い指示を受け、Codexが公式情報の調査、掲載候補の生成、認証済み管理画面の「公開待ち」への登録まで進める。公開待ちデータは非公開で、正規管理者認証とOwnerの対象限定公開承認に基づく公開RPCが成功するまで一般公開しない。

最初の依頼に含まれる「追加」「登録」は公開承認ではない。Ownerが公演またはIDを指定して正式公開を明示指示した場合は、その指示を対象限定で継承し、最新内容・画像・候補ハッシュとの一致を確認して正規管理者認証済みAPIから自律公開できる。二度目のGOやブラウザOK操作は必須ではない。一般的な追加・登録依頼だけの場合は公開前承認を得る。スキル `.agents/skills/ara-works-publish/SKILL.md` を適用する。

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

`OPEN` は公式情報で「OPEN」または「開場」と明示された入場開始時刻、`START` は「START」または「開演」と明示された公演開始時刻、`CLOSE` は「CLOSE」「END」「終演」等と明示された終了時刻を登録する。公式イベント告知に開始〜終了の時間帯だけが載る場合は、開始側をOPEN、終了側をCLOSEとしてそのまま登録する。`official_sources[].confirms` の同じ公式ソースに、ラベル付き時刻、または `event_time_range: "22:00 - 04:00"` を記録して公開候補へ渡る。

`22:00 - 04:00` のような公式イベント告知の時間帯は、OPEN 22:00 / CLOSE 04:00として保存する。終了時刻をSTART欄へ保存しない。CLOSEの24時超表記（`25:00`等）は翌日1:00へ変換せず、原表記のまま保持する。

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
- Ownerの対象限定の明示公開指示、または代表の手動公開操作を候補全体の承認根拠とする。画像掲載指示・画像確認・監査は維持する
- 確認した同一画像バイトをSHA-256付きで既存 `work-flyers` Storageへ正規API保存してから公開する。保存済みの検証済み画像は再利用し、再取得・再アップロードしない。取得、整合性確認、Storage保存のいずれかに失敗した場合は公開しない
- 画像を掲載しない場合だけ「編集」で「画像を掲載しない」を選択して保存する。画像差し替えも編集画面から行う
- 画像掲載設定、Storage path、取得元、画像SHA-256、その他の公開内容が変わると候補ハッシュが更新され、以前の承認は無効になる
- 「見送り」は候補だけを非公開のまま見送りにし、既存公開実績は削除しない
- サービスロールキーや認証回避は使わない

## 6. 対象限定承認に基づき正規APIで公開する

Ownerが対象を指定して正式公開を明示承認した作業は、既存管理者のgetUserとwork_admins/RLSで本人・権限を確認し、APIで公開まで継続する。ブラウザ公開ボタン/OKの自動押下は標準方式にしない。手動管理画面の確認ダイアログも引き続き利用できる。一般的な追加依頼を公開承認に拡張しない。フライヤー候補がある場合は、一覧に表示した同一バイトをStorageへ保存する更新を元の候補SHA-256に限定して実行し、更新後の候補SHA-256を公開RPCがもう一度DBの最新値と照合する。一覧表示後に内容が変わっていれば公開せず再確認を求める。成功時に `approved_hash`、承認者、承認日時を記録し、その同じ行を公開状態へ変更する。

本番DBの `announcement_confirmed_on` には、この最終公開操作の日を設定する。

## 7. 公開後確認

詳細ページのHTTP 200、表示内容、画像、title、canonical、OGP、Event構造化データ、sitemap、公式リンク、モバイル表示を確認する。加えて既存の開催予定2件を回帰確認する。いずれかが未確認なら成功扱いにしない。

## DBへの対応

OPEN / START、SEO、候補ハッシュ、承認ハッシュ、確認用画像URL、画像取得方法、画像利用確認状態、公開画像ON/OFF、公開画像の取得元・SHA-256・確認者・確認日時を `work_posts` に保持する。一般公開画像は従来どおり既存 `work-flyers` Storageを使用し、Ownerが候補全体の正式公開を対象限定で明示承認した場合だけ、一覧表示と同一の画像を認証済み経路でコピーする。選択・再確認・解除は `work_candidate_image_audit` に追記する。


## 認証・再実行・Return

既存認証済み実行環境のSupabase clientを使用する。管理SQL接続は公開承認権限ではない。ブラウザtoken/password抽出、service_role/postgres代用、is_published直接書換えは禁止。スキルのhelperは資格情報を取得せず、新しい認証基盤やHTTP endpointを作らない。認証済みAPI実行面がない場合は、管理者本人の既存セッション内での起動が不足条件であると記録する。WKS-001はOwnerが管理画面の固定10件APIを一度起動して成功した実績であり、完全なブラウザ非依存実行の証明ではない。その固定スコープを別案件へ拡大しない。

最新候補が変更されていればRPC前にHOLD。公開済みは再公開しない。RPC結果不明なら同じDB行を読戻し、自動再送しない。画像承認actor/timeと公開承認actor/time、hash、監査を維持する。

ローカル正本・サニタイズ済みBridge要約・クラウド読戻しを別々に保存する。送信先を明示承認されたブラウザReturnは、完全URL/Project/Conversation ID/会話内容、空の入力欄、生成完了、操作競合なしを確認して一度だけ送信する。新規ユーザーメッセージと返信マーカー・生成完了、利用可能な独立会話読戻しを照合する。独立読戻しが古い場合は画面受領PASSと厳密なBROWSER_RETURN HOLDを分ける。正式ACKは独立証拠がなければUNVERIFIED。公開失敗だけを理由に独立したReturnを省略しない。新規Return基盤は作らない。
