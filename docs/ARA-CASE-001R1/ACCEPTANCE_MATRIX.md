# 必須20シナリオ

全体 PARTIAL。以下のPASSは明記したローカルfixture範囲だけを意味する。READY_FOR_COMMANDER_ACCEPTANCEではない。

|#|判定|証拠・不足|
|---|---|---|
|1|PARTIAL|実PA migrations適用、PA画面とGmail/contract/receipt回帰PASS。公開PAフォーム実入口E2Eと全機能回帰は未実施|
|2|NOT_RUN|一般/施工フォーム→保存は未接続。Gmail候補→施工原文/開催日NULLの別経路はbrowser PASS|
|3|NOT_RUN|公開submit・通知ジョブ競合/timeout未実装・未試験|
|4|NOT_RUN|公開同一ID別内容拒否未実装。別thread同emailはDB fixtureで分離|
|5|NOT_RUN|一般受付commit/通知失敗設計保留|
|6|NOT_RUN|一般受付thread未取得/後関連E2Eなし|
|7|PASS_LOCAL|候補→Ownercreate→既存Gmail返信index。実UI/API/PGlite・RESTadapter・fake Gmail|
|8|PARTIAL|3sync metadata重複0、同一接続create/linkretry1case。別PG接続・複数tab競合はNOT_RUN|
|9|PARTIAL|同email別thread分離、既存別case link拒否、番号fallback除去。実転送/通知多様体は未試験|
|10|PARTIAL|SQL atomic/advisory/unique、同一接続conflict拒否。別接続競合NOT_RUN|
|11|PASS_LOCAL|exclude再syncで維持、別新着は残る。fake Gmail label/delete変更0|
|12|PASS_LOCAL|実trash RPC後archived linkは候補/newcaseにならずarchive維持|
|13|PARTIAL|既存managedsend7/7 synthetic、選択serial/previewguard。実ブラウザで全await点A→B遅延注入は未実施|
|14|PASS_LOCAL|非PA sync portal skip、通常fake返信後PA status/progress不変、commercial拒否、PA子tableDB拒否、UI非表示|
|15|PASS_LOCAL|2page失敗でcursor維持→retry取りこぼし/metadata重複0|
|16|PASS_LOCAL|personal profile503、一覧維持/失敗表示、fallbackなし。実OAuth認証失効は未試験|
|17|PARTIAL|outbound/既存link除外。Formspree内部通知全形式・実顧客返信先判定は未完成|
|18|PARTIAL|新API未認証401・RPC権限/adminactor確認。既存全case/attachment/send入口の本環境統合権限試験は未網羅|
|19|PARTIAL|既存8scriptsと追加配送3scripts PASS、正式受注29/29/添付/Receipt/警告fixture回帰。署名TTL・精算・全migration統合の全組合せ未網羅|
|20|PARTIAL|Functions12/12、syntax/diffcheckPASS、切替計画あり。Productionbuild/plan制限/旧コード互換は未検証・deployHOLD|

18/18新DBchecksは ISOLATED_DB_TEST.json、ブラウザは BROWSER_TEST.json、既存回帰は REGRESSION_FINAL.json と FINAL_VERIFICATION.json。初期失敗は REGRESSION_INITIAL.json に残す。REGRESSION_FINAL の2件NOT_FOUNDは探索時の誤ったfilenameであり、正しい010r1/r2/r3はFINAL_VERIFICATIONに記録。実システム不具合2件と数えない。
