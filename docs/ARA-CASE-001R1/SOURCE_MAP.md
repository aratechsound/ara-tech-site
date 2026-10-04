# ARA-CASE-001R1 SOURCE_MAP

判定: PARTIAL。これはローカル候補の対応表であり、Production schema/deployment の確認書ではない。
基準: `999ec1b3077f4e3ac1a72188a4e94ed1f719b757`。正規 repository は `C:\Users\user\Documents\Codex\ARA-TECH\ara-tech-site`、remote は `https://github.com/aratechsound/ara-tech-site.git`。canonical main、local origin/main、read-only remote main readback が一致。独立 worktree/branch `ara-case-001r1-local` に限定して編集。

## 受付の現物

|入口|現行経路・根拠|今回の扱い|
|---|---|---|
|PA|`pa-inquiry.html` → `js/pa-inquiry.js` → `api/pa-inquiry.js` normalizeInquiry/registerInquiry → `pa_inquiries`|入力・URL・登録APIは変更せず、DBの由来判定で PA_EVENT を付与|
|contact|`contact.html` から PA は `pa-inquiry.html?source=contact`、一般は `general-inquiry.html`|既存導線を保持|
|一般|`general-inquiry.html` の `contact-form` action は `https://formspree.io/f/mojqjwnr`、Formspree AJAX initForm/unpkg|DB登録への接続は未実装。外部設定の自動返信・通知・CAPTCHA・迷惑対策が不明のため該当切替を保留|
|施工|`installation.html` → `general-inquiry.html`|種別初期値なし。今回変更なし|
|PA通知|`api/pa-inquiry.js` は受付保存後、既存 `_pa-mail.cjs` の acceptance/internal notification 配送処理へ進む|既存経路保持。新一般フォームの単一受付・atomic通知記録・内容一致idempotencyの完了は主張しない|

一般フォームに browser 二重submit は追加していない。Formspree 設定を source から推測しない。既存PAの同一 submission_key は unique だが、既存 API の duplicate lookup は内容一致を検証しない。受付と通知記録も一つの新RPCに統合していない。この既存の仕様差を今回の受入3–6のPASSとして数えない。

## 単一rootと共通情報

|論理情報|物理正本|
|---|---|
|identity/番号|既存 `pa_inquiries.id` / `inquiry_number`。既存採番を保持|
|種別|追加 nullable `case_type`、指定7値。NULL は「未分類」。PAフォームの submission_source/key と first_form_data provenance が揃う行だけ backfill|
|受付元/日時|既存 `submission_source` (`manual`/`public_form`) / `received_at`。Gmail import は manual、`first_form_data.import_source='gmail_owner_confirmed'` に由来を保持|
|顧客/組織/連絡先|既存 customer_name / organization_name / contact_name / email / phone|
|概要/原文|追加 `case_subject`、既存 request_summary / first_form_data。Gmail import 原文は first_form_data.original_body / original_snippet。上限20,000字|
|希望時期/場所|追加 `desired_period`、既存 venue。event_date は非PAで架空値を入れず NULL|
|メモ/次対応|既存 internal_memo、追加 next_action|
|archive|既存 trash/archive RPCと列を維持。archived linkも全体lookupに含め、受信だけで復活させない|
|元フォーム識別子|既存 submission_key / first_form_data。新一般フォーム受付は保留|
|メール関連|既存 pa_gmail_thread_links / pa_gmail_message_index / pa_case_mail_attention / sync記録|

共通rootを別tableへ複製しない。未紐付けmetadataだけ `ara_unlinked_mail`、mailbox固定cursorだけ `ara_mail_sync_state` を追加。候補へ仮case IDは付けない。
PA progress trigger 本体は維持し、明示非PAでは実行しない WHEN 条件を追加。NULL legacy の trigger は互換目的で維持するため、既存の由来不明PA progress行は削除していない。UIはNULLをPAと断定せず未分類表示。種別分類のOwner編集機能は未実装。

## Gmail再利用と権限

`api/pa-gmail.js` の既存認証/origin/rate-limit routerへ inbox_list / inbox_sync / inbox_decide を局所追加。新 `.js` Function なし。
`api/_ara-unlinked-mail.cjs` は既存 `_pa-gmail.cjs` の gmailJson / gmailMessage / normalizeMessage / global thread lookup、既存 `_pa-mail.cjs` の Supabase/OAuth を利用する。同期・添付取得・indexThread・recordSync・manualLink・返信preview/send自体は既存エンジンを利用する。
Gmail `/profile` の認証メールアドレスが `aratechsound@gmail.com` と一致しなければ取得拒否。個人アカウントの代用なし。環境秘密情報が無く、実際のサイト接続profileは未確認。
未紐付け探索は30日、1回50件までの1page。ページとcursorの記録を ara_commit_mail_page の同一transactionで確定。2page失敗時cursor維持。過去期間の明示追加探索UIは未実装。
DRAFT/SENT/SPAM/TRASH/outboundを除外。広告のAI判定はなし。既知システム通知の全形式に対する分類・返信先保証は未完了。
thread/referenceからの自動bindは既存確定link/provider identityを優先し、受付番号だけのfallback bindを除去。メール件名/emailだけでは新規bindしない。
候補create/link/excludeは admin認証 → service-role限定RPC → p_actorのwork_admins確認。thread advisory lock +既存一意制約 +同一TXで案件/link/decision/auditを作る。競合は409を返し、既存別case linkを上書きしない。excludeは候補だけ、Gmail削除/既読/移動をしない。
新tableはadmin SELECTのみ。anon/authenticatedにDML不可、RPC executeはservice_roleのみ。既存case rootのRLSは維持。
候補画面はmetadata/snippetと添付有無まで。確定前の全文・添付viewerは未完成。登録時は既存Gmail取得を再利用して原文を保存するが、この不足を受入完了と扱わない。

## PA境界と画面

`js/ara-case.mjs` は7種別、既存配置のfilter、候補操作を追加。`pa-admin.html` / `js/pa-admin.js` は共通一覧、件名/希望時期/次対応、未紐付け欄を追加。URL/deep linkは維持。
非PAではPA工程/商流/見積送付/契約/精算/ポータル/日程確保フォーム/イベント入力を隠す。通常返信は既存preview/Owner承認/send経路。非PA sync はportal候補検出をskip。商流返信とestimate reconciliationはrequirePaCaseで拒否。DB側はPA専用子tableへの非PA writeをguard。
guard対象は現物 `pa_case_progress`, `pa_payment_records`, `pa_contract_offers`, `pa_case_commercial_state`, `pa_estimate_revisions`, `pa_commercial_outbox`, `pa_commercial_documents`, `pa_portals`, `pa_stage_plots`, `pa_stage_plot_revisions`。optional tableはto_regclassで確認。
非同期 case読み込みに選択serial、返信previewに開始時snapshotガード。既存 managed-send binding を維持。メール取得失敗では保存済みデータを残す。同期失敗と一覧取得失敗は別表示。
非PA rootの全状態・全既存RPC/保守tool経路を網羅してPA意味論を禁止できたとは主張しない。旧コードとのrollback互換も未解決。

## 証拠の境界

実PA migration 26本と新migration1本をPGliteへ適用。platform auth/role prelude は既存fixture、RESTはローカルprotocol adapter、Gmailはfake。このschemaは実migrationだが、実PostgREST/別接続PostgreSQLではない。UI→実handler→実service→同DBをEdgeで試験。外部ネットワークを遮断。
既存回帰fixtureのGmail `/profile` とrequirePaCase prerequisite GETだけ追加。期待値変更なし。初期PDF pending/ready不一致は基準commitとの比較後、異なる依存runtime解決が原因と特定し、canonical node_modulesを再利用して既存期待値のままPASS。
Production公開static GET2件だけを取得。deploy identity・実DBschema・実OAuth・実施工メールは未確認。admin Production画面は自動write回避のため開いていない。

Functionsは基準/候補ともapi/*.js=12。契約plan制限・Production build/deployは未確認。パッケージbuild scriptなし。実メール送信0、Production mutation0、push/deploy/main merge0。
