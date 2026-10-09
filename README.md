# cccDataImporter

## setting envroments

## TODO
- [ ] Alice-Feed-exclusion


## 依存関係とローカル検証

このリポジトリの依存関係は **Yarn Classic 1.22.22 と `yarn.lock`** を正本とします。
GitHub Actions、Gitpod、Lerna は Yarn を使用しています。Node は Lerna の要件
（22.13 以上の 22 系、24 系、または 26 系）を満たす版を使用してください。
Lerna 10 への更新により Node 20 は対応対象外です。
既存の Node/Actions 移行 PR #874 はこの依存修正とは別です。

```sh
corepack yarn install --frozen-lockfile
corepack yarn test
```

`test` はロックの互換性と実際の依存 API を検査した後、既存の JavaScript テスト
5 ファイルを一度だけ実行します。個別実行は `test:aliceBlogChecker`、`test:common`、
`test:getPopularProducts`、`test:getPopularRepositories` を使用できます。
`fetchRss` と `notifyDiscord` には独立したテストファイルがなく、それらの処理の
網羅性までは保証しません。依存検査の Sharp はメモリ内の画像だけを扱います。
アプリの `start` や実際の投稿・認証処理は検証コマンドに含めません。

`package-lock.json` は過去の npm グラフです。Yarn の正本とは一致せず、例えば
Supabase の解決版が異なるため、このファイルからの `npm ci` は同等の検証にはなりません。
現在は既存ワークフローのキャッシュキーが参照しているので残しています。
削除する場合はキャッシュキーを `yarn.lock` へ移す作業と合わせて行ってください。

依存パッケージの major を一律に置換する `resolutions` は使用しません。
Lerna の `minimatch` 3.1.4 → 3.1.5 以上、`js-yaml` 4.3.0 → 4.3.2 以上、
Nx の `brace-expansion` 5.0.9 → 5.0.12 以上、`axios` 1.18.1 → 1.20.0 以上は、
consumer を限定した同 major
セキュリティパッチ例外です。既存の `tar` 7 系の最低版は 7.5.22 です。
Sharp は 0.35.5 以上を使用し、依存テストは実際に読み込まれた librsvg 2.63.2
以上・libvips 8.18.7 以上とメモリ内の画像変換を確認します。
この修正は API 互換性を回復するためのもので、全セキュリティ警告の解消を意味しません。
