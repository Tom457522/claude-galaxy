# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Claude Code CLI を複数セッション並列でブラウザから管理する、ローカルホスト専用アプリ(Node.js / Express 5 / ws / node-pty)。ビルド工程はなく、フロントエンドもバンドラなしの素の JS。UI 文言・コメント・README・コミットメッセージはすべて日本語。

## コマンド

```bash
npm install            # 初回(node-pty のネイティブバイナリを含む)
npm start              # node server.js → http://localhost:3456
npm test               # node --test(test/*.test.js をすべて実行)
node --test test/jobs.test.js                       # 1 ファイルだけ
node --test --test-name-pattern="<名前>" test/x.test.js  # 1 テストだけ
```

- Windows では `start.bat` でも起動できる(初回 npm install + ブラウザを開く)。
- 主な環境変数: `PORT`(既定 3456)/ `APPS_PORT`(ローカル Web アプリ配信用の別ポート)/ `CLAUDE_CMD`(新規セッションの既定コマンド)/ `CLAUDE_JOB_CMD` / `GALAXY_PERMISSION_WAIT`(受信箱の待ち秒数)/ `GALAXY_NO_PLAN`。
- lint・フォーマッタの設定はない。CI(`.github/workflows/test.yml`)は Ubuntu / macOS × Node 20 / 22 で `npm ci && npm test`。

## テストの注意

- 外部テストライブラリは使わず `node:test` + `node:assert` のみ。
- 状態は `~/.claude-galaxy/` に保存されるため、そこを読み書きするモジュールの単体テストは `test/helpers.js` の `tempHome()` で HOME / USERPROFILE を一時フォルダにしてから対象モジュールを `require` する(順序が重要)。
- `test/server.test.js` は本物の `server.js` を偽の claude(`test/fixtures/bin/claude`)で起動する結合テストで、**Windows ではスキップ**される。本物の Claude は呼ばない。

## アーキテクチャ

- **`server.js`** が中心。Express + WebSocket + node-pty で、セッションごとに PTY を持ち入出力を中継する(Windows は `cmd.exe /c` 経由の ConPTY、macOS / Linux はログインシェル経由)。各機能モジュールは `createXxx()` ファクトリで生成し、それらと共有ヘルパーを 1 つの `ctx` オブジェクトにまとめて `routes/*.js`(`module.exports = function routes(ctx)`)に渡す。新しい API は該当する routes ファイルに追加し、必要なら `ctx` にも足す。
- **Claude Code との連携は 2 つの子スクリプト経由**(どちらもユーザーの `~/.claude/settings.json` は書き換えない):
  - `hook.js`: 起動コマンドが `claude` のとき `--settings <一時ファイル>` で hooks を登録し、イベントを `127.0.0.1` の本体へ通知する。stdout には何も出さず常に exit 0(例外: `PermissionRequest` は受信箱の決定を JSON で返す)。`claude` 以外のコマンド・`wsl claude`・サブコマンド・自前 `--settings` のときは hooks を付けない。
  - `mcp-bus.js`: stdio の MCP サーバー `galaxy`。`--mcp-config` で各エージェントに渡され、ツール呼び出しを本体の `/api/bus` に中継するだけ(状態は本体の `bus.js` が持つ)。
  - どちらも環境変数 `GALAXY_PORT` / `GALAXY_TOKEN` / `GALAXY_SESSION` で本体と通信する。トークンはエージェントごと・起動ごとに発行され、トークンから呼び出し元を決める(なりすまし防止)。
- **ジョブ**(`jobs.js`): `claude -p --output-format stream-json` を子プロセスで実行するキュー。`automations.js` / `cron.js` が時刻・ファイル変更・コミット・前ジョブ完了をきっかけにジョブを登録する。エージェントが登録するジョブは権限モードや段数・件数に制限がある(`agents.js` / `routes/agent-api.js`)。
- **起動コマンドの組み立て**は `cmdline.js`、git の差分・worktree は `git.js`、MCP サーバー管理は `tools.js`、使用量・予算・プラン利用率・クラウド使用量は `usage.js` / `budget.js` / `plan.js` / `cloud.js`。
- **永続化**は `~/.claude-galaxy/`(`sessions.json`・`jobs.json`・`bus.json`・`automations.json`・`settings.json`・`logs/`・`jobs/` など、`store.js` 経由)。MCP 設定や hooks 設定の一時ファイルは OS の一時フォルダ `claude-galaxy/` に作り、終了時に消す。
- **フロントエンド**(`public/`): `index.html` が `ui.js` → 各 `*-view.js` → `app.js` の順に `<script>` で読み込む(モジュールではなくグローバル共有なので順序に依存)。xterm は `node_modules` から `/vendor/...` として配信。`public/vendor/graph3d.bundle.js` は生成物で、再ビルド手順は `vendor-src/README.md`(通常は触らない)。

## 注意点

- セキュリティ前提: `127.0.0.1` のみで待ち受け、Host / Origin ヘッダーを検証している。ローカル Web アプリは `APPS_PORT` の別オリジンで配信し、本体の `/api`・`/ws` を呼べないようにしている。これらを緩める変更はしないこと。
- hook / MCP が本体に送る情報は最小限に絞っている(ファイル内容は送らない)。送る項目を増やすときは README の該当説明も更新する。
- README.md は機能ごとの詳しいユーザー向け説明(日本語)になっている。ユーザーから見える挙動を変えたら該当節も更新する。
- 新しい API・機能・画面を足すときは `galaxy-feature` スキル(`.claude/skills/galaxy-feature/SKILL.md`)の手順に従い、最後に `galaxy-security-reviewer` エージェントでセキュリティ前提を緩めていないか確かめる。
- `graphify-out/` はナレッジグラフの生成物(gitignore 済み)。構造把握には `graphify-out/GRAPH_REPORT.md` が使える。コード変更後は `graphify update .` で更新できる。
