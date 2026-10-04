# 移行・切替・切戻し計画

現候補は PARTIAL / DEPLOY_HOLD。本番migration、push、deployを実行しない。Commander監査とOwner承認は、残項目完成後の別操作。

1. 既存サイト接続のread-only authorityを取得し、Production deployment commit/schema/RLS/Function planとFormspreeの通知・自動返信・迷惑送信対策を確認。既存業務Gmailprofileと実施工問い合わせをread-onlyで特定。認証secretは監査成果物に含めない。
2. 一般受付を既存routerへ接続し、内容fingerprintを含むsubmit idempotencyと受付/必要通知ジョブの同一TXを実装。従来通知機能を保持する単一server受付にする。旧/new通知同時発火をしない。provider開始後UNKNOWNは自動再送しない。フォームは完成するまで現行経路を継続。
3. 候補全文/添付確認、明示過去期間探索、通知thread識別、全PA副作用境界、旧コード互換を完成。実PostgRESTと別接続PostgreSQLで受入20項目、2tab/timeout/競合、A→B遅延、切戻しの一般案件可視性を試験。
4. 本migrationはforward-only additive。適用前snapshot/restore計画と既存PA未知行の分類レビューを用意。破壊的downmigration・候補/一般受付/除外記録削除を切戻しに使わない。既存progress triggerはfunction本体を維持するがtrigger条件変更も監査対象。
5. 承認後の別taskで、互換コード→migration→新一般受付有効化の順を確定。実順序は未実装のfeature gate/互換版完成後に再監査する。公開受付を止める空白を作らず、旧通知経路の停止と新経路有効化を単一起点で行う。
6. 異常時は新一般受付有効化を停止する互換版へforward fixし、受け付け済み一般案件を共通一覧と原文で閲覧可能に維持。既存PA受付は継続。`999ec1b`旧コードへそのまま戻すと非PA行をPAと解釈/進捗single欠落を起こし得るため、そのrollbackは禁止条件。実互換試験未完了。

## 実施工問い合わせ

NOT_IDENTIFIED。正規repository/environmentに既存業務Gmail OAuth authorityがなく、実profile/messagesを取得していない。別の個人Gmail connectorは使用していない。必要情報は既存サイト接続のread-only取得経路と対象のおおよその受信日時/送信元/件名。識別子は未確認につき作らない。Production案件create/bind/reply0。将来旧フォーム通知importは受付確認を再送しない。

## ローカルPreview

`http://127.0.0.1:8871/pa-admin.html`、fixture login `owner@example.invalid` / `fixture-only`。127.0.0.1のみ。実UI/既存handler/full PA migration PGlite、RESTadapter/fake Gmail、秘密情報なし。インメモリDBのためserver再起動でfixture初期化。
Nodeで `tests/ara-case-local-preview.cjs` を実行。PGlite解決はcanonical installed module、必要なら PA_PGLITE_MODULE を設定。`../fixture-supabase.js` は同梱runtime/fixture-supabase.jsからworktree親へ置く。canonical node_modulesは既存依存を読み取り再利用し、install/lock変更はしていない。新端末ではnode依存解決を別途準備。
このPreviewはProductionの反映・アカウント・実メール・配送を証明しない。
