# PA正式受注フロー Release Candidate

この候補はローカル検証用です。本番deploy、migration適用、push、実顧客メール送信、本番契約成立を許可しません。

## 凍結した土台

- Production / remote main: `9d8a627067dc0c346bca8a10d30e5acc9ceb22f7`。
- 正本ローカル main: `c2e81ae73f143490d6df3984f3910a79f779b13c`。変更していません。
- Gmail・見積送付の統合候補: `db7cd572676a66ff42e05a3f7170c74c5170ad79`。本候補はこのcommitから分離しています。
- Vercel Production readback: deployment `C8AYuHFLJ94LeZ1yC8AFikBikgnS`, Ready, source `9d8a627` (2026-09-07確認)。公開PA HTML/JS/CSS・旧日程フォーム等6資産は同commitのGit blobと一致。
- Supabase `kogbnremsouajxxsgxro` を `BEGIN READ ONLY / SELECT / ROLLBACK` で確認。正式契約テーブルなし。Gmail indexのmessage_source列と見積reconciliation RPCは未反映。

## 操作

1. 対象案件の上部「正式受注確認を開始」を開きます。
2. この案件のprimary Gmail threadから顧客へ送付済みのPDFを選び、「選択したPDFを確認」でダウンロード・hash照合します。任意の外部URLや他案件ファイルを受け付けません。
3. 契約上の顧客名・税込契約金額・依頼内容を確認します。支払例外は管理者が明示承認した場合のみ設定できます。
4. URLを発行します。tokenは32 random bytes。URL fragmentで渡し、顧客ページは初期化直後にaddress barから削除します。DBにはhashだけを記録。発行日を1日目とするJST7日間、8日目00:00で失効します。
5. 顧客が氏名・同意を入力して正式依頼。DBの同一案件ロックで再発行・回答を直列化し、append-only snapshot、token消費、正式受注の進捗を同一transactionで保存します。
6. snapshotの条件ページと元見積ページを結合し、元PDFバイナリも埋込添付として保存します。quoteは再描画しません。PDF生成失敗時も契約成立は保存され、管理画面から生成を再試行できます。
7. 管理画面で控え送信をプレビューし、明示操作で既存のブランドメール・Gmail返信threadを使って送信します。成立とメール結果は独立します。送信失敗は再試行可能。Gmail送信後のaudit/sync失敗・応答消失は結果不明とし、自動再送せず、送信済みの確認と重複リスク了承を要求します。

成立済みv1は変更できません。重要条件の変更は新しい見積・条件のv2以降として再発行・再確認します。未回答URLの再発行は旧tokenを不可逆に失効させます。成立済みURLは回答受付済み表示だけになります。

## 保存と境界

- 新規5テーブル：offers / tokens / contracts / receipts / deliveries。PDFはprivateなbyteaで保存し、認証APIだけが取得します。公開Storage URLや署名URLは発行しません。
- browserのanon/authenticated rolesに契約テーブルやRPCの直接アクセス権はありません。管理者APIは既存のverifyAdminを使います。public APIはtokenだけで対象を特定し、case ID等の余分な入力を拒否します。
- snapshot、提示見積、生成控えはUPDATE/DELETE禁止のtriggerで保護。旧日程確保資産・既存migrationは無変更。
- 新APIは同一origin、no-store、noindex、no-referrer、分散rate limit。顧客ページには外部script・font・analyticsを読み込みません。tokenはログ、監査、browser storageに保存しません。
- 最終見積は1,500,000 bytes・30ページ以内。暗号化・フォーム・署名・注釈等を含むPDFはfail closed。控えはGmail既存上限に合わせ3 MiB以内。新しい運用用環境変数は不要です。

## 公開サイトとの条件差（未変更）

2026-09-07の [PAレンタル公開ページ](https://ara-tech.cc/pa-rental.html) と比較しました。

| 項目 | 公開サイト | 今回の個別契約 |
| --- | --- | --- |
| 支払 | 終了後1週間以内 | 終了後14日以内・承認済み例外可 |
| キャンセル30% | 7日前〜4日前 | 2026-09-18〜10-10 |
| キャンセル50% | 3日前〜2日前 | 2026-10-11〜10-16 |
| 雨天 | 前日正午までの連絡、その後は規定料金と説明 | 天候・台風も同一標準率、不可避実費を下回らない |

旧日程確保ページには33,000円の条件があります。今回の個別契約の0%期間と併存する場合の扱いを勝手に合わせず、旧資産を保存しました。今回の条件を使用する判断と、既存案内との差の顧客への説明は初回実送信前に確認してください。

## Release前の必要事項

- ユーザーの別工程での本番反映承認。既存統合候補のPAM-003/004/005と今回のmigrationを、適用済み状態を再照合して順序どおり適用すること。本タスクでは適用していません。
- 今回のmigration: `20260907130000_pa_formal_contract.sql`。前提の旧migrationは内容・hashを変更していません。
- 候補ソース・依存ライブラリ・日本語fontを一緒に反映し、管理者認証、DB/RLS、PDF取得を本番でreadbackすること。
- 竹林様の最終見積PDF、税込金額、契約名義を最終指定すること。fresh-readの案件表示名は「2026龍姫湖まつり」、名義情報は「龍姫湖まつり実行委員会」であり、行政部署名と同一と推測しません。
- ユーザーの明示確認を受けて初回URL・メール実送信を行うこと。本番の正式依頼確定は顧客が行う操作です。

## ローカル検証

`pnpm install --frozen-lockfile --ignore-scripts` の後、`node tests/validate-pa-contract.cjs` を実行します。PGlite上で実migration・実API/service・既存Gmail MIMEコードを使い、全通信はfixtureで処理します。実ネットワークfetchは拒否します。既存のPA/Gmail/見積回帰27スイートも実行しました。

390pxおよびPCの表示・操作はローカルfixture serverで検証しています。検証PDFはテスト氏名・テスト金額で作成し、本番契約の証明ではありません。invoice自動生成、入金、スタッフ、資料ページ等は本候補に含みません。
