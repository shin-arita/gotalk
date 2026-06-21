# Testing

## 現在の位置づけ

GoTalk のテストは、現時点ではテスト基盤整備段階です。Backend Unit Test の第一段階と、Frontend Unit Test 基盤を CI に組み込んでいます。

OpenAI API など外部サービスへ実際に接続するテストは前提にしていません。CI 上で安定して実行できる範囲として、アプリケーション側で制御できるロジックと UI の基本動作を中心に検証しています。

## 完了済み

### Backend Unit Test 第一段階

現在の backend test では、以下を検証しています。

- `whisperLangMatches` の言語タグ照合
- `extractJSON` の JSON 抽出
- `/health` handler のレスポンス
- `writeError` の JSON error response
- CORS middleware の通常リクエスト処理
- CORS middleware の OPTIONS 処理

### Frontend Unit Test 基盤

現在の frontend test では、以下を検証しています。

- 言語定義 `LANGUAGES` の件数、必須項目、ID 一意性、主要言語データ
- 言語選択画面の表示
- 2 言語未満のとき開始ボタンが無効になること
- 2 言語選択時に開始ボタンが有効になること
- 言語カード選択と解除
- 3 言語目を追加しない制御
- 録音開始、停止、`onStart` callback の呼び出し

## 完了済み（続き）

### Backend Unit Test 第二段階

`http.DefaultClient.Transport` をテスト用 `mockTransport` で差し替えることで、外部 API への実通信なしに以下を検証しています。

**translateHandler**

- GET → 405
- `OPENAI_API_KEY` 未設定 → 500
- invalid JSON → 400
- `text` 空（空白のみ）→ 400
- `languages` 1件 → 400
- `callOpenAI` transport error → 502
- OpenAI レスポンスが非 JSON → 502
- `sourceLanguage == "unknown"` → 422
- `sourceLanguage` がいずれの言語とも不一致 → 422
- 正常系 → 200、レスポンス内容を検証

**interpretHandler**

- GET → 405
- `OPENAI_API_KEY` 未設定 → 500
- Content-Type が multipart でない → 400
- `audio` フィールド未指定 → 400
- `myLanguage` が不正 JSON → 400
- `myLanguage.id` が空 → 400
- `theirLanguage` が不正 JSON → 400
- `theirLanguage.id` が空 → 400
- Step 1（言語判定 Whisper）transport error → 502
- Step 1 が空 `language` を返す → 502
- Step 2 で言語不一致（`language_mismatch`）→ 422
- Step 3（文字起こし Whisper）transport error → 502
- Step 4（OpenAI 翻訳）transport error → 502
- OpenAI レスポンスが非 JSON → 502
- 正常系 myLang 一致 → 200
- 正常系 theirLang 一致（src/tgt 逆転）→ 200

**callOpenAI**

- transport error → error
- 非 200 ステータス → error
- 非 JSON レスポンス → error
- `output` 空配列 → error
- `content` 空配列 → error
- 正常系 → TrimSpace 済み文字列を返す

**callWhisper**

- transport error → error
- 非 200 ステータス → error（レスポンスボディ付き）
- 非 JSON レスポンス → error
- `whisper-1` モデル → `response_format=verbose_json`、language を返す
- `gpt-4o-transcribe` モデル → `response_format=json`

---

## coverage 結果（Backend Test 第二段階完了時点）

```
gotalk/main.go:52:   corsMiddleware      100.0%
gotalk/main.go:65:   writeError          100.0%
gotalk/main.go:71:   healthHandler       100.0%
gotalk/main.go:77:   callOpenAI           91.7%
gotalk/main.go:128:  extractJSON         100.0%
gotalk/main.go:142:  callWhisper          83.9%
gotalk/main.go:197:  whisperLangMatches  100.0%
gotalk/main.go:225:  interpretHandler     97.1%
gotalk/main.go:353:  translateHandler    100.0%
gotalk/main.go:448:  main                 0.0%
total:                                   92.2%
```

## 実装変更なしで coverage 100% に届かない理由

### 未到達のブロックと理由

| 関数 | 未到達ブロック | 理由 |
| --- | --- | --- |
| `callOpenAI` | `json.Marshal` の error 分岐 | 対象 struct がすべて string フィールドのため Marshal は絶対に失敗しない |
| `callOpenAI` | `http.NewRequest` の error 分岐 | `openAIResponsesURL` は有効な const URL のため NewRequest は失敗しない |
| `callWhisper` | `mw.CreateFormFile` の error 分岐 | `bytes.Buffer` への書き込みは失敗しない |
| `callWhisper` | `part.Write` の error 分岐 | 同上 |
| `callWhisper` | `mw.WriteField("model")` の error 分岐 | 同上 |
| `callWhisper` | `mw.WriteField("response_format")` の error 分岐 | 同上 |
| `callWhisper` | `http.NewRequest` の error 分岐 | `whisperURL` は有効な const URL のため失敗しない |
| `interpretHandler` | `io.ReadAll(file)` の error 分岐 | multipart ファイルはメモリ上にあるため ReadAll は失敗しない |
| `main` | 関数全体 | `http.ListenAndServe` がブロックするため、テストから呼び出せない |

### 構造的な原因

- 外部 API の URL が `const` で固定されており、テストから差し替えられない
- handler が `callOpenAI` / `callWhisper` を直接呼ぶ（dependency injection なし）
- `http.DefaultClient.Transport` の差し替えは有効だが、NewRequest/Marshal の内部エラーパスには届かない

### 将来 100% を目指す場合の方針

実装変更が許容される場合は以下を検討:

1. **OpenAI クライアントを interface 化する**  
   `type OpenAIClient interface { Do(*http.Request) (*http.Response, error) }` を定義し、handler に注入する。テストでは失敗する実装を渡せる。

2. **URL を変数化する**  
   `openAIResponsesURL` と `whisperURL` を const から var にすると、テストで書き換えてエラーを誘発できる。ただし本番仕様への影響を要評価。

3. **`http.NewRequest` を wrapper 関数経由にする**  
   エラーを注入できる関数ポインタを持つことで、到達不能だった error return を通過させられる。

4. **`main()` の起動ロジックを分離する**  
   `run()` 関数に切り出してテストから呼び出せるようにする（goroutine + listener ready チャネルを使うパターン）。

## 今後予定

### Frontend Test 拡張

- Interpreter page の翻訳レスポンス表示
- 認識テキスト編集後の再翻訳 flow
- language mismatch 表示
- history 表示と展開
- speech synthesis 呼び出し部分の UI 挙動

## Frontend

Frontend は Vitest、Testing Library、jsdom を使ってテストします。

```bash
cd frontend
npm ci
npm run lint
npm run test
npm run test:coverage
npm run build
```

| コマンド | 内容 |
| --- | --- |
| `npm run lint` | ESLint による静的解析 |
| `npm run test` | Vitest の単体テスト |
| `npm run test:coverage` | coverage 付きテスト実行 |
| `npm run build` | TypeScript build と Vite build |

## Backend

Backend は Go 標準の `go test` と `go vet` を使って検証します。

```bash
cd backend
go vet ./...
go test ./...
go build -o /tmp/gotalk-backend .
```

| コマンド | 内容 |
| --- | --- |
| `go vet ./...` | Go の静的解析 |
| `go test ./...` | Go の単体テスト |
| `go build -o /tmp/gotalk-backend .` | backend binary のビルド確認 |

## Docker 起動確認

必要に応じて、Docker Compose で起動状態を確認します。

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/health
```

`/health` が `{"status":"ok"}` を返せば、backend の基本起動は成功です。

## CI で実行される検証

Pull Request と main push では GitHub Actions により以下が自動実行されます。

- Frontend lint: `npm run lint`
- Frontend test: `npm run test`
- Frontend coverage: `npm run test:coverage`
- Frontend build: `npm run build`
- Backend vet: `go vet ./...`
- Backend test: `go test ./...`
- Backend build: `go build -o /tmp/gotalk-backend .`
