---
name: galaxy-feature
description: claude-galaxy に新しい API・機能・画面を足す作業を、決まった手順(入力を決める → routes / ctx / モジュール / テスト / UI / README の順で作る → npm test → セキュリティレビュー → 修正 → 報告)で行う。「API を追加して」「エンドポイントを足して」「〜機能を付けて」「タブ・画面に〜を出して」「galaxy に〜できるようにして」などで使う。対話セッションでも Galaxy のヘッドレスジョブでも動く。
argument-hint: <対象(機能の短い名前)> [やりたいことの説明や関連ファイルのパス]
---

# claude-galaxy 機能追加ワークフロー

このリポジトリ(claude-galaxy のルート)で実行する。構成と決まりは `CLAUDE.md` に従う。UI 文言・コメント・README はすべて日本語で書く。外部ライブラリは足さない(`package.json` の dependencies を増やさない)。

## 0. 入力を決める

- 対象: 引数の最初の語。なければ依頼内容から短い名前を決める(英小文字とハイフン。報告と Galaxy のメモリのキーに使う)。
- 依頼内容: 引数の文章と、渡されたパスのファイルをすべて読む。続けて `CLAUDE.md`、`server.js` の `ctx` の定義(`const ctx = {` の周辺)と routes の登録行(`for (const r of [...]) require(\`./routes/${r}\`)(ctx)`)、関係する `routes/*.js`・機能モジュール・`public/*-view.js`・README の該当節を読む。`graphify-out/GRAPH_REPORT.md` があれば構造の把握に使ってよい。
- 変更範囲を決める: 「API だけ」「機能モジュール + API」「UI も」「README の更新が要るか(ユーザーから見える挙動が変わるか)」を書き出す。

**ヘッドレス(Galaxy のジョブなど、質問に答える人がいない)では質問しない。** 依頼から読み取れないこと(API のパス名・入力の形・どのタブに出すか など)は、既存の API と画面に倣った妥当な仮定を置いて進め、報告に `[仮定]` を付けて列挙する。対話セッションでは、セキュリティ前提(下の「緩めてはいけないこと」)に触れそうな点と、画面のどこに出すかだけ最初にまとめて確認してよい。

### 緩めてはいけないこと(どの手順でも守る)

- `server.js` の `HOST = '127.0.0.1'` での待ち受け(本体・`APPS_PORT` の両方)。
- 本体の Host / Origin 検証ミドルウェアと、WebSocket の upgrade での Origin 検証(`OK_ORIGINS`)。
- ローカル Web アプリを `APPS_PORT` の別オリジンで配信すること(GET / HEAD のみ、`frame-ancestors` の CSP)。apps サーバーに API を足さない。
- `hook.js` / `mcp-bus.js` が本体に送る項目は最小限(ファイル内容は送らない)。増やすなら README の該当説明も直す。
- エージェント(hook / MCP)からの API は `hookAuth(req)` でトークンから呼び出し元を決める。本文の `sessionId` や `from` を信用しない。
- エージェントが登録するジョブの制限(`jobs.js` の `normalize` の `strict`: bypassPermissions / auto / 許可ツール指定の禁止、`server.js` の `MAX_AGENT_DEPTH` / `MAX_AGENT_JOBS`、`agents.js` の段数・件数チェック)。
- ユーザーの `~/.claude/settings.json` を書き換えない。

## 1. 決まった順で作る

上から順に作る。不要な段は飛ばしてよいが、順番は崩さない。

| 順 | 作るもの | 場所 | 決まり |
|---|---|---|---|
| 1 | 機能モジュール(ロジックがあるとき) | ルートの `<名前>.js` | 状態や依存を持つなら既存に倣い `createXxx({...})` ファクトリで依存を受け取る。状態のない純粋な処理は関数をそのまま export してよい(`cmdline.js`・`cron.js`・`doctor.js` の `diagnose` に倣う)。保存が要るなら `store.js` 経由で `~/.claude-galaxy/` に置く。既存モジュールに収まるならそこに足す |
| 2 | `ctx` への追加(routes から新しいものを使うとき) | `server.js` の `const ctx = {...}` | 1 で作ったものや共有ヘルパーを足す。routes ファイルはモジュールを直接 `require` せず、すべて `ctx` 経由で受け取る(`server.js` 冒頭で `require` し、起動時に一度だけ作る値は `const ctx` の直前で作る)。各 routes ファイル先頭の分割代入は、使う名前だけ足す |
| 3 | API | 該当する `routes/*.js` | 各ファイル先頭のコメント(担当範囲)に合う所に足し、担当範囲が広がったらそのコメントも直す(迷ったら: 診断・検索・バックアップ・予算・使用量など管理系は `system.js`、画面の初期値・グラフ・アプリ一覧は `misc.js`)。結果を返すだけの API は `ctx.wrap` を使う(戻り値を JSON に、例外を 400 にする)。`module.exports = function routes(ctx)` の形を保つ。新しい routes ファイルを作ったときは、`server.js` の登録配列にも名前を足す。入力は型と長さを検査し、エラーは日本語で返す |
| 4 | テスト | `test/<名前>.test.js` | 下の「テストの決まり」 |
| 5 | UI(必要なとき) | `public/` の `*-view.js`、`public/index.html`、`public/style.css` | 下の「UI の決まり」 |
| 6 | README | `README.md` の該当節 | ユーザーから見える挙動を変えたら日本語で更新する。新しいモジュールは「仕組み」、テスト対象が増えたら「テスト」の一覧にも足す。hook / MCP の送る項目を変えたら「セキュリティ」や該当機能の節も直す |

### テストの決まり

- `node:test` と `node:assert` だけを使う(外部ライブラリは入れない)。
- 単体テストは先頭で `const { tempHome } = require('./helpers'); const home = tempHome();` を呼び、HOME / USERPROFILE を一時フォルダにしてから対象モジュールを `require` する(順序が重要。逆にすると本物の `~/.claude-galaxy/` を汚す)。テスト用の一時ファイルもこの `home` の下に作る。保存も HOME も使わない純粋な関数だけのモジュールなら省いてよい(`cmdline.test.js`・`cron.test.js`)。
- routes は単体テストを持たない。API の振る舞いはロジックを機能モジュールに寄せて単体テストで確かめる。API そのものを確かめたいときは `test/server.test.js`(偽の claude `test/fixtures/bin/claude` で本物の `server.js` を起動する結合テスト)に足す。このファイルは `tempHome()` を使わず、1 つのサーバーを起動した `test('Claude Galaxy サーバー', { skip }, async (t) => { ... })` の中に `await t.test('<日本語の名前>', async () => { ... })` を足し、`api('GET', '/api/...')` ヘルパーで呼ぶ(新しい `test(...)` を外に作らない)。**このテストは Windows ではスキップされる**ので、Windows で作業したときは「結合テストは未実行(CI の Ubuntu / macOS で実行される)」と報告する。
- 本物の Claude や外部サービスは呼ばない。

### UI の決まり

- 画面は `public/` の `*-view.js` に、既存と同じく即時関数で書き、公開するものだけ `window.XxxView` に載せる。共通部品は `window.UI`(`ui.js`)を使う。HTML に埋め込む文字列は必ずエスケープする(既存の `esc` に倣う)。
- 新しい `*-view.js` を作ったら `public/index.html` の `<script>` に足す。読み込み順は **vendor → `ui.js` → 各 `*-view.js` → `app.js`** を守る(モジュールではなくグローバル共有なので順序に依存する)。タブの表示切り替えは `app.js` 側の既存の書き方に倣う。
- `public/vendor/graph3d.bundle.js` は生成物なので触らない。

## 2. 機械チェック

```
npm test
```

失敗が 0 件になるまで直して再実行する。ただし環境によって変更前から落ちるテストがある(例: Windows で `test/tools.test.js` の接続確認)。失敗したテストが今回の変更と関係なさそうなら、変更したファイルに触れないそのテスト単体(`node --test test/<名前>.test.js`)を実行して変更前から落ちることを確かめ、「既存の失敗」として名前と理由を報告に書く(直さなくてよい)。`node_modules` が無くても単体テストは動くが、`server.js` を起動する確認をするときは先に `npm ci` を実行する。加えて次を確かめる。

- 変更した JS ファイルごとに `node --check <ファイル>` が通る。
- `git status --short` と `git diff --stat` で、意図しないファイル(`package.json` の dependencies、`public/vendor/`、`~/.claude/settings.json` に触れる処理など)が変わっていない(新規ファイルは `git diff` に出ないので `git status` で見る)。
- 変更した行だけを `git diff -U0 | grep -E '^[+-][^+-]'` で取り出し、上の「緩めてはいけないこと」に関わる語(`HOST`・`OK_ORIGINS`・`APPS_PORT`・`hookAuth`・`strict`(`use strict`・`strictEqual` は除く)・`MAX_AGENT_`・`hook.js`・`mcp-bus.js`)が含まれないか。新規ファイルも同じ語で grep する。あれば手順 3 で必ず重点的に見てもらう。

Windows では `test/server.test.js` がスキップされる。npm test の出力の skipped 件数を控えておき、報告に書く。

## 3. レビュー

`galaxy-security-reviewer` サブエージェントに、今回の変更(`git diff` と新規ファイルの一覧)のレビューを依頼する。依頼文には対象、変更したファイル、README を更新したかどうかを書く。新規ファイルは `git diff` に含まれないので、パスを列挙して読んでもらう。セッションの作業フォルダがこのリポジトリでないなどで `galaxy-security-reviewer` が一覧に無いときは、定義 `.claude/agents/galaxy-security-reviewer.md` を読ませる指示と「Read / Glob / Grep だけを使い、ファイルを変更しない」を依頼文に書いて汎用サブエージェントに渡す(サブエージェント自体が使えない環境では、その定義の観点で自分でレビューする)。

指摘のうち「重大」と「要修正」はすべて直し、直したら手順 2 をもう一度実行する。依頼の意図と衝突して直せない「要修正」は、より安全な代案で直すか、理由を添えて報告に残す。「提案」は報告の残課題に回してよい。

## 4. 結果を伝える

最後の応答に、次を短くまとめる。

- 対象と、変えたファイルの一覧(新規 / 変更)
- 追加した API(メソッドとパス)・画面・設定
- npm test の結果(成功・失敗・スキップの件数。Windows なら server.test.js がスキップされたこと。既存の失敗があればその名前と、変更と関係ないことを確かめた方法)
- レビューの結果(重大・要修正をどう直したか、残した提案)
- `[仮定]` の一覧と、README を更新した節
- git の commit / push はしていないこと(頼まれたとき以外はしない)

Galaxy のツール(`mcp__galaxy__*`)が使える場合は、加えて次を行う。使えない場合はこの段を飛ばす。

- `mcp__galaxy__memory_write` に `{"key": "galaxy-feature/<対象>/summary", "value": "<要約・変えたファイル・テスト結果・リポジトリの絶対パス>", "tags": ["galaxy-feature", "<対象>"]}` を渡す。
- `mcp__galaxy__send_message` に `{"to": "parent", "text": "<完了の知らせ>"}` を渡す(引数名は `to` と `text`。`"parent"` はほかのエージェントが `submit_job` で登録したジョブのときだけ使う。人が始めた対話セッションや、人が画面から登録したジョブ、そのサブエージェントでは `to` を `"user"` にする)。`[仮定]` や残した指摘があれば件数と代表例を添える。
