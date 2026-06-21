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

## 今後予定

### Backend Test 第二段階

- `/api/interpret` handler の validation
- `/api/translate` handler の validation
- `language_mismatch` のレスポンス
- OpenAI API 呼び出し部分を mock した翻訳レスポンス処理
- multipart audio request の異常系

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
