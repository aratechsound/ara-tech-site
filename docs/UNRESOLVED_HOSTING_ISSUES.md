# ホスティングに関する未解決事項

## ARA-TECH公式サイトのVercel Hobby商用利用

- 記録日: 2026-08-10
- 対象: `https://ara-tech.cc/`
- 状態: 未解決（オーナー判断待ち）

ARA-TECH公式サイトは事業用サイトである。一方、Vercelの現行利用規約では、Hobbyプランの利用は個人または非商用用途に限られている。このため、現行のHobbyプランで事業用サイトを運用している状態は正式な未解決事項として扱う。

根拠:

- [Vercel Terms of Service - Hobby Plan](https://vercel.com/legal/terms)
- [Vercel Pricing - plan comparison](https://vercel.com/pricing)

今回、Pro契約、課金設定、ホスティング移行は行っていない。別案件で、次のいずれかをオーナーが判断する。

1. Vercel Proへ変更する
2. 無料または低コストで商用利用可能な別ホスティングへ移行する

判断時は、最新の利用規約と費用に加えて、カスタムドメインとSSL、Git連携、Vercel Functions相当のAPI、環境変数、リダイレクト、デプロイとロールバック、アクセス解析、移行停止時間を比較する。
