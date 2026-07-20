# 旧URL・新URL対応表

本番移行時は、以下を1対1の恒久リダイレクト対象とする。今回は本番リダイレクトを設定していない。

| 実績ID | 旧URL | 新URL | 本番移行時の扱い |
|---:|---|---|---|
| 37 | `https://ara-tech.cc/work.html?id=37` | `https://ara-tech.cc/works/2026-hyakka-ryoran-vol-20.html` | 1対1の301 |
| 22 | `https://ara-tech.cc/work.html?id=22` | `https://ara-tech.cc/works/2026-sonsi.html` | 1対1の301 |
| 27 | `https://ara-tech.cc/work.html?id=27` | `https://ara-tech.cc/works/2025-christmas-party-27.html` | 1対1の301 |

一覧ページへの一律転送は行わない。クエリ文字列を条件に正しい固有URLへ振り分けられる配信基盤またはEdge処理が必要となる。

