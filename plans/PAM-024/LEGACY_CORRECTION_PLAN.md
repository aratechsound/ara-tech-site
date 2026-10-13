# PAM-024 — 吉岡／岸本電工の限定訂正計画（ローカルレビューのみ）

状態: NOT_EXECUTABLE / OWNER_REVIEW。SQL、migration、live API、メール送信は実行していない。

## 確認済み対象とUNKNOWN

根拠はPAM-021の保存readback `2026-10-05T17:15:06.626218+00:00` とPAM-023 RESULT。fresh DB結果として扱わない。

| 条件 | exact値 |
|---|---|
| 吉岡case | `516bed8d-ff81-4a52-b53b-fc89161088ec` |
| 案件番号／type | `PA-20261006-00017` / `AV_INSTALL` |
| 顧客email | `tyjan17th@gmail.com` |
| ownerimport | `first_form_data.import_source=gmail_owner_confirmed` |
| 正しい原message | `1a1074e34ef4b6a9` |
| 共通thread | `1a1074e34ef4b6a9` |
| 誤帰属message | `1a109d9b5c652662` |
| 保存索引の岸本received_at | `2026-10-05T02:17:04+00:00` |
| 保存索引の吉岡received_at | `2026-10-04T14:25:26+00:00` |
| 岸本本文identity（既存RCA） | `kishimotodenko.nakagawa@gmail.com` / 岸本電工 |

岸本raw Reply-To、現在選択中のexact返信source／To、fresh DBはUNKNOWNを保持する。focused testsのReply-To/RFC headersは合成値であり、追加live証明ではない。

## 最小訂正の実行前条件（将来の別承認）

Owner承認された専用経路でfresh状態を取得し、上のcase、number、type、email、ownerimport、原message/threadがすべて一致することを確認する。Owner入力、root revision、監査、PA業務recordsのbefore snapshot/hashを保存する。通常の詳細再表示やinbox_reviewをread-onlyとして使わない。前者はauto-sync、後者はrate-limit writeを含む。

変更allowlistは `pa_gmail_message_index` の exact三条件（inquiry_id=吉岡case、gmail_thread_id=共通thread、gmail_message_id=岸本message）が同時一致する誤帰属1行と、吉岡caseの `pa_case_mail_attention` の派生値だけ。行数0/複数、値のdrift、別caseへの移動済み、UNKNOWNならHOLD。thread全体／email一致の一括訂正は禁止。

誤帰属indexを顧客会話から除外する方策は、将来の承認時にbefore imageを保全した exact行の削除または最小解除を選定する。現行indexのNOT NULL/FK等を未確認のままnull更新SQLを作らない。本candidateはライブ訂正コード／SQLを含まない。

`ara_unlinked_mail` の保存証拠には吉岡候補1行だけがある。岸本候補の存在や状態を推測して変更しない。将来exact岸本行の誤帰属が確認された場合だけ、既存CHECK（linked ⇔ inquiry_id非NULL）を満たす pending/null解除を追加のOwner判断へ返す。全threadをexcludedにしない。Gmail原messageを消去しない。自動create/link／別案件作成は行わない。

## 再混入防止とdry-run期待差分

先にcandidateの限定同期guardを採用できるかレビューする。ownerimportのFormspree原messageはrootのexact原message/threadとReply-Toが顧客emailへ一致する場合のみ許可する。別Formspree通知やUNKNOWNは索引、timeline、attentionに入れない。bodyからidentityを推測しない。既存PAの通常同期は変更しない。

fixtureでは誤帰属indexが2→1、岸本行だけが除外、吉岡message・thread link・rootが不変。2回再同期しても岸本index writeは0。attentionのlast_seen_inbound_atは吉岡の正しい受信日時へ戻る。new_customer_reply / waiting_customer / none は残った正しい時系列から再計算するため、freshの送受信が増えていれば状態を固定しない。last_synced_at/updated_atは許可された派生変更として別記する。

root変更0、Owner入力変更0、PA業務変更0、歴史監査の更新/削除0、別案件create0、メール送信0が必要。訂正後に別の監査記録をappendし、before/after hash、exact対象、actor、承認、理由、除外数、再同期検証結果を保存する。過去のgmail_threads_synced/message_count=2監査は改変しない。

focused testは合成headers＋injected transportで実処理を動かしたローカル検証と、ローカル配列での訂正dry-run。live DB制約やライブ訂正transactionを検証したとは主張しない。

## 復元と将来の別案件化

復元はbefore imageを使うexact行だけ。復元時も正しいroot、Owner入力、PA、監査を保持する。guardを無効化してthread全件を再取り込むことを復元手段にしない。誤帰属indexの復元は誤表示を再現し得るため、別Owner判断が必要。メール送信は取消できないため復元対象にしない。

岸本message自体・既存保存証拠・将来Owner判断は保存する。恒久的なglobal exclusionや別案件の予約を加えない。ただし現行 `pa_gmail_thread_links` はthread単位の排他、`ara_decide_mail` はリンク済みthreadを既存caseへ戻す実装であり、同一threadの岸本を別caseへ安全に取り込む経路は未実装。この既存制約を本candidateで再設計しない。将来の別案件化は、exact messageを入力にする別途レビューの対象。全面schemaが必須だとは結論しない。

## 適用禁止条件

local PASSはProductionREADYを意味しない。COMMON Production E2Eの受付→保存→通知が別承認でPASSするまでFormspree停止/削除は禁止。flag=falseによるLEGACY経路は保持する。PAM-022 D/Eのwidget/secret/policy不足、Security122 UNKNOWNを引き継ぎ、Cloudflare/env/Productionの変更はこの計画に含めない。
