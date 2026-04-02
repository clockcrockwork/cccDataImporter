# Code Review: cccDataImporter

> レビュー実施日: 2026-03-24

## 概要

コードベース全体を対象にコードレビューを実施しました。
CRITICAL 3件、HIGH 6件、MEDIUM 6件、LOW 3件の指摘事項があります。

`getPopularProducts` と `common/httpClient` は最近のコミットでセキュリティ強化・リトライロジック改善が行われており、他のパッケージと比較して品質が高い状態です。他のパッケージにも同様の改善を適用することを推奨します。

---

## CRITICAL — ランタイムエラーを引き起こすバグ

### 1. `fetchRss/src/index.js:225` — Set に対して存在しない `addError()` を呼び出し

`processFeeds()` (L172) で `errors = new Set()` として初期化していますが、`processFeed()` (L225) では `errors.addError(error)` を呼び出しています。`Set` には `addError` メソッドが存在しないため、フィード処理中にエラーが発生した場合、エラーハンドリング自体が `TypeError` で失敗します。

```js
// L172: Set として初期化
const errors = new Set();

// L225: 存在しない addError() を呼び出し
errors.addError(error); // TypeError: errors.addError is not a function
```

**修正案:** `new Set()` → `createErrorArray()` に変更するか、`errors.add(error)` に変更

### 2. `getPopularRepositories/index.js:46` / `getWhatsToday/index.js:48` — 空配列への未チェックアクセス

`data[0].forum_id` を配列の長さチェックなしでアクセスしています。Supabase から空のレスポンスが返った場合、`TypeError` が発生します。

**参考:** `getPopularProducts/index.js:84-87` では既に安全なチェックが実装済みです。

### 3. `getPopularRepositories/index.js:97-98` — split 結果の未チェックアクセス

`post.content_html.split('<br>')[1]` で、`<br>` が含まれない HTML の場合 `undefined` になります。また `content_html` が `undefined`/`null` の場合も `TypeError` が発生します。

**参考:** `getPopularProducts/index.js` では `toSafeContentHtml()` で安全に処理済みです。

---

## HIGH — セキュリティ・信頼性

### 4. `fetchRss/src/index.js` — 共通の `fetchWithRetry` / `postDiscordOrThrow` を使用していない

`common/httpClient.js` にリトライ付き HTTP クライアントが実装されていますが、`fetchRss` は素の `node-fetch` を直接使用しています。Discord API のレート制限（429）やネットワークエラーに対する耐性がありません。

### 5. `aliceBlogChecker/src/index.js` — 同様に素の `fetch` を使用

Discord 投稿、エラー通知、画像 API 呼び出しすべてがリトライなしの素の `fetch` です。

### 6. `aliceBlogChecker/src/index.js:268` — `handleError()` に `await` がない

`postRandomImageToDiscord` の catch ブロックで `handleError(error)` を `await` なしで呼び出しています。エラー通知が完了する前にプロセスが終了する可能性があります。

### 7. `fetchRss/src/index.js:104` / `getPopularRepositories/index.js:112` — URL エンコーディングなし

`thread_id` パラメータをエンコードしていません。`getPopularProducts` (L166) では `encodeURIComponent` を使用済みです。

### 8. `fetchRss/src/index.js:22` — 未使用の `streamPipeline`

`promisify(pipeline)` をインポートしているが未使用です。

### 9. `aliceBlogChecker/src/index.js:6` — 未使用の `fs` インポート

`fs` はコード内で一度も参照されていません。

---

## MEDIUM — コード品質・保守性

### 10. `createErrorArray()` が 4 ファイルに重複

`fetchRss`, `getPopularProducts`, `getPopularRepositories`, `getWhatsToday` に完全に同一の関数が存在します。`packages/common/` に移動すべきです。

### 11. `getDiscordThreadId()` が 3 ファイルに重複

`getPopularProducts`（安全）、`getPopularRepositories`（危険）、`getWhatsToday`（危険）にバリデーションレベルの異なる関数が存在します。

### 12. `aliceBlogChecker` が CommonJS、他のパッケージは ESM

モジュールシステムの統一を検討してください。

### 13. `aliceBlogChecker/src/index.js:62-79` — コメントアウトされたコード

GitHub Issue 自動作成のコードブロックが残存しています。

### 14. `fetchRss/src/index.js:278-285` — `latestUpdates` に `undefined` が含まれる可能性

`map()` で `fullFeedData` が見つからない場合、暗黙的に `undefined` が返されます。`.filter(Boolean)` で除外すべきです。

### 15. テストカバレッジ不足

`fetchRss`, `getWhatsToday`, `getPopularRepositories`, `notifyDiscord`, Python スクリプトにテストがありません。

---

## LOW — 改善提案

### 16. マジックナンバーの定数化

バッチサイズ `15`, トップ `10` 件, ページ番号上限 `200`/`1000` など。

### 17. `fetchRss/src/index.js:147` — `response.buffer()` は非推奨

`response.arrayBuffer()` + `Buffer.from()` を使用してください。

### 18. `fetchRss/src/index.js:150` — PNG の `quality` オプションは無効

Sharp の PNG フォーマットには `quality` パラメータが存在しません（JPEG/WebP 用）。

---

## 総合評価

| カテゴリ | 件数 | 主な対象 |
|---------|------|---------|
| CRITICAL | 3 | `fetchRss`, `getPopularRepositories`, `getWhatsToday` |
| HIGH | 6 | `fetchRss`, `aliceBlogChecker`, `getPopularRepositories` |
| MEDIUM | 6 | 全パッケージ横断 |
| LOW | 3 | `fetchRss`, `aliceBlogChecker` |

### 推奨アクション（優先度順）

1. **CRITICAL バグの修正** — `fetchRss` の Set/addError 不一致、空配列アクセス
2. **`fetchWithRetry` の全パッケージ展開** — `fetchRss`, `aliceBlogChecker` への適用
3. **共通関数の `common/` への集約** — `createErrorArray`, `getDiscordThreadId`
4. **`getPopularProducts` のセキュリティパターンを他パッケージに展開**
