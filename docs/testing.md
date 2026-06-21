# Testing

## テスト方針

GoTalk のテストは、外部 API への実通信を避けながら backend handler、OpenAI 連携まわりのエラーハンドリング、frontend の主要画面と UI ロジックを CI で検証します。

OpenAI API など外部サービスへ実際に接続するテストは実行しません。CI 上で安定して実行できる範囲として、アプリケーション側で制御できるロジックと UI の基本動作を中心に検証しています。

## Backend Unit Test

backend test では、以下を検証しています。

- `whisperLangMatches` の言語タグ照合
- `extractJSON` の JSON 抽出
- `/health` handler のレスポンス
- `writeError` の JSON error response
- CORS middleware の通常リクエスト処理
- CORS middleware の OPTIONS 処理

## Frontend Unit Test

frontend test では、以下を検証しています。

- 言語定義 `LANGUAGES` の件数、必須項目、ID 一意性、主要言語データ
- 言語選択画面の表示
- 2 言語未満のとき開始ボタンが無効になること
- 2 言語選択時に開始ボタンが有効になること
- 言語カード選択と解除
- 3 言語目を追加しない制御
- 録音開始、停止、`onStart` callback の呼び出し
- 録音中のカード操作抑止
- 録音失敗時の復帰
- MediaRecorder の mime type 選択
- unmount 時の録音停止
- Interpreter page の翻訳レスポンス表示
- 認識テキスト、翻訳文、バックトランスレーションの表示
- language mismatch 表示
- HTTP 500 エラー時の UI 復帰
- history 表示と展開
- speech synthesis 呼び出しとボタン状態
- マイク権限拒否時のエラー表示

## OpenAI API 呼び出しまわり

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

## coverage 結果

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

## coverage の読み方

Backend coverage は handler と OpenAI 連携まわりの分岐を中心に確認しています。以下のブロックは、実装構造上の到達不能パスまたはサーバー起動エントリポイントのため、単体テストの対象外です。

| 関数 | 対象外ブロック | 理由 |
| --- | --- | --- |
| `callOpenAI` | `json.Marshal` の error 分岐 | 対象 struct が string フィールドのみで、Marshal 失敗を通常入力から発生させられない |
| `callOpenAI` | `http.NewRequest` の error 分岐 | `openAIResponsesURL` は固定の有効な URL |
| `callWhisper` | `mw.CreateFormFile` の error 分岐 | multipart writer の出力先がメモリ上の `bytes.Buffer` |
| `callWhisper` | `part.Write` の error 分岐 | multipart writer の出力先がメモリ上の `bytes.Buffer` |
| `callWhisper` | `mw.WriteField("model")` の error 分岐 | multipart writer の出力先がメモリ上の `bytes.Buffer` |
| `callWhisper` | `mw.WriteField("response_format")` の error 分岐 | multipart writer の出力先がメモリ上の `bytes.Buffer` |
| `callWhisper` | `http.NewRequest` の error 分岐 | `whisperURL` は固定の有効な URL |
| `interpretHandler` | `io.ReadAll(file)` の error 分岐 | handler test の multipart ファイルはメモリ上で生成している |
| `main` | 関数全体 | `http.ListenAndServe` を呼び出すサーバー起動エントリポイント |

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

Docker Compose 起動確認は、CI の単体テストとは別に frontend/backend のコンテナ起動と `/health` 応答を確認する手順です。

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
