# cccDataImporter

## setting envroments

## TODO
- [ ] Alice-Feed-exclusion


## 依存関係とローカル検証

このリポジトリの依存関係は **Yarn Classic 1.22.22 と `yarn.lock`** を正本とします。
アプリの Node は **24 系**とし、使用するパッチ版をルートの `.nvmrc` に固定します。
GitHub Actions と Gitpod もこのファイルを参照します。Node のパッチ更新は
`.nvmrc` を変更し、依存インストールと以下のテストを確認してください。
GitHub Actions 自体の内部ランタイムは各 Action の管理対象です。

```sh
nvm install
nvm use
corepack yarn install --frozen-lockfile --non-interactive
corepack yarn test
```

`test` はロックの互換性と実際の依存 API を検査した後、既存の JavaScript テスト
5 ファイルを一度だけ実行します。個別実行は `test:aliceBlogChecker`、`test:common`、
`test:getPopularProducts`、`test:getPopularRepositories` を使用できます。
`fetchRss` と `notifyDiscord` には独立したテストファイルがなく、それらの処理の
網羅性までは保証しません。依存検査の Sharp はメモリ内の画像だけを扱います。
アプリの `start` や実際の投稿・認証処理は検証コマンドに含めません。

## 秘密情報を使わないテスト CI

`Application tests` は `origin` 向けの Pull Request と `origin` への push で実行します。
標準の `ubuntu-latest` runner、読み取り専用権限、20 分の制限で、リポジトリの
secrets を渡さず `yarn test` 全体を実行します。既存テストの外部 API はモックまたは
注入したテスト用クライアントで扱い、Discord 投稿・Supabase 認証を起動しません。
インストール・テスト後には manifest と lockfile が書き換わっていないことも確認します。

Node を使う定期処理の依存インストールとテスト CI は共通の
`.github/actions/setup-node-yarn` を使用します。Yarn の版は `packageManager` から
確認し、リポジトリルートで frozen install します。キャッシュ対象は Yarn の
ダウンロードだけで、キーには Node の固定版・manifest・`yarn.lock` を含めます。
`node_modules` や npm のキャッシュは再利用しません。

RSS の Sharp は `yarn.lock` にある optional binary を使用します。
`SHARP_IGNORE_GLOBAL_LIBVIPS=1` によりホストの libvips 検出を無効にし、
実行時の `yarn add sharp` や `--ignore-engines` は使いません。
依存テストのメモリ内画像変換で、実際に読み込まれた Sharp/libvips を確認します。
`packages/fetchRss/start-with-deps.sh` も同じ固定 Node と root lockfile を使います。

`package-lock.json` は過去の npm グラフです。Yarn の正本とは一致せず、例えば
Supabase の解決版が異なるため、このファイルからの `npm ci` は同等の検証にはなりません。
CI のインストールとキャッシュでは参照せず、履歴との比較用に残しています。

依存パッケージの major を一律に置換する `resolutions` は使用しません。
Lerna の `minimatch` 3.1.4 → 3.1.5 以上、`js-yaml` 4.3.0 → 4.3.2 以上、
Nx の `brace-expansion` 5.0.9 → 5.0.12 以上、`axios` 1.18.1 → 1.20.0 以上は、
consumer を限定した同 major
セキュリティパッチ例外です。既存の `tar` 7 系の最低版は 7.5.22 です。
Sharp は 0.35.5 以上を使用し、依存テストは実際に読み込まれた librsvg 2.63.2
以上・libvips 8.18.7 以上とメモリ内の画像変換を確認します。
この修正は API 互換性を回復するためのもので、全セキュリティ警告の解消を意味しません。
