# PAUI-079 閲覧とGmail同期の分離

Base: 226361ab336f6f6e5e729bb36247f51a8c7c2dd0（PAUI-078 Production）。

Quote Monitorのstart/ensureは保存済み検査結果の読取りだけにする。自動原本検査・自動継続を起動しない。明示的な「変更見積を再確認」も既存メール索引を対象とし、Gmailの探索同期を呼ばない。画面にこの対象範囲を表示する。

実際の新UIが使うmail-candidate-viewと、残存するmail-discoveryのcheckは、既存GET /data/mail-discoveryの保存情報だけを表示する。25ページの同期ループと閲覧に伴うonIndexed呼出しを除去。書込み経路は既存の明示確認済み関連付け判断だけを許可する。閲覧による最新確認は実行していないことと、保存された最終同期記録を区別して表示する。

既存のQuote Monitor・商務保存結果の読取りには、既存API契約のメタデータPOSTも残る（quote_monitor_list/status、snapshot、original_index等）。これは保存済み読取りであり、同期・検査・商務変更とは区別して通信監視する。メール探索はGETのみ。

手動Gmail同期API、メール送信、一般受付、契約・請求・入金、PAUI-078の終了処理と全種別ゴミ箱、DB関数・ACLは変更しない。新タイマー・自動再送・DB migrationなし。

検証はtests/validate-paui079-passive-view.cjsと、今回の挙動変更に直接関係する既存4テストのみ。合成セッション・合成応答・fetch呼出し監視でログイン、復元、再読込み、一覧再取得、PA/一般選択、概要/やり取り/見積、保存済み表示、画面復帰をPC/モバイルで確認。既存PAUI-077/078の別機能PASSは再利用する。

tests/paui079-preview.htmlは架空データだけのローカルPreview。保存・送信・外部通信を拒否する。tests/の配備除外は維持する。Production公開は別途Owner判断であり、このTaskでは行わない。
