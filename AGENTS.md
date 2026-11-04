# ARA-TECH Codex instructions

## 開催予定イベントの半自動登録

ARA-TECHの公演登録・開催予定追加・WORKS正式公開・既存候補の再開では、`.agents/skills/ara-works-publish/SKILL.md` を適用し、`docs/UPCOMING_EVENT_CODEX_WORKFLOW.md` を読むこと。明示呼出しは `$ara-works-publish`。PA案件・Gmail変更には適用しない。

- `scripts/add-upcoming-event.mjs` でローカルの調査ブリーフを作る。
- 会場・主催者・アーティストの公式情報を優先し、日付、会場、イベント名を照合する。
- 第三者まとめサイトや検索結果だけを公開根拠にしない。
- 画像は技術的な取得可否と転載許可を分けて扱う。利用確認がない画像は公開ペイロードに含めない。
- 候補データと `review.md` を作り、最新内容・画像・候補ハッシュを確認する。既存候補は再利用し、重複登録しない。
- 最初の依頼文に含まれる一般的な「追加して」は、確認画面表示後の公開承認として扱わない。
- Ownerが対象公演またはIDを指定して正式公開を明示指示した場合、その対象限定で正規管理者認証済みAPIから公開まで自律継続できる。既存の明示指示に一致する内容について二度目のGOやブラウザOK操作を要求しない。一般的な追加依頼だけの場合は公開前承認を得る。承認対象外の変更・公式情報との不一致はHOLDする。
- 既存管理者セッション・getUser・work_admins/RLS・既存Storage・publish_work_candidate RPCを使用する。画像確認、承認者/日時、最新candidate_hash照合、公開監査を維持する。ブラウザ自動クリックを標準公開方式にしない。is_published直接更新、postgres/service_role承認代行、認証回避、ブラウザ秘密情報の抽出は禁止。利用可能な認証済み実行経路がなければ具体的な不足条件を記録する。
- 公開後は詳細ページ、画像、title、canonical、OGP、Event構造化データ、sitemap、公式リンク、モバイル表示を確認する。
- AraOS / ARA AI Company OSには変更を加えない。
- 成果と公開のPASS/HOLD、Bridge保存、クラウド読戻し、許可された元会話へのブラウザReturn、正式ACKを独立判定する。公開HOLDでも安全に実施可能なReturnは同じ実行ターンで行う。

## WORKS API公開ランタイム
既存の認証済み管理者APIによる公演公開は .agents/skills/ara-works-publish/scripts/works-publish-cli.mjs を優先する。本人ログイン/権限/画像/候補ハッシュを検証し、直接SQLやブラウザ自動クリックで代替しない。
