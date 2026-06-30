# Development

## 1. 開発環境概要

GoTalk の標準開発環境は Docker Compose です。`docker-compose.yml` には次の 3 service が定義されています。

| Service | 役割 | Port | 主な用途 |
| --- | --- | --- | --- |
| `frontend` | React / TypeScript / Vite の開発サーバー | `5173:5173` | ブラウザ UI の起動 |
| `backend` | Go の API server | `8080:8080` | 翻訳、バックトランスレーション、TTS |
| `backend-dev` | Go 開発用コンテナ | なし | `gofmt`、`go test`、`go build` などの Backend 開発コマンド |

通常の動作確認では `frontend` と `backend` を起動します。`backend-dev` は通常運用で常時起動する service ではなく、Backend の開発コマンドを実行するために使います。

`frontend` には `VITE_BACKEND_URL=http://backend:8080` が設定されます。Vite の proxy により、Frontend からの `/api` request は Backend service に転送されます。

## 2. 必要ソフトウェア

Docker Compose で開発する場合に必要なものは次のとおりです。

- Docker
- Docker Compose
- OpenAI API キー

ホスト上で個別に Frontend / Backend コマンドを実行する場合は、次も必要です。

- Frontend: Node.js 22
- Backend: Go 1.24

Dockerfile では Frontend に `node:22-alpine`、Backend に `golang:1.24-alpine` を使っています。

## 3. 初回セットアップ

Repository を clone します。

```bash
git clone <repository-url>
cd gotalk
```

Repository root に `.env` を作成し、OpenAI API キーを設定します。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_MODEL` は Compose で `gpt-4o-mini` が default になっています。

Image を build します。

```bash
docker compose build
```

通常起動します。

```bash
docker compose up
```

background で起動する場合は次を使います。

```bash
docker compose up -d
```

## 4. 起動方法

### 通常起動

通常のアプリケーション確認では `frontend` と `backend` を起動します。

```bash
docker compose up frontend backend
```

build も同時に行う場合:

```bash
docker compose up --build frontend backend
```

停止:

```bash
docker compose down
```

ログ確認:

```bash
docker compose logs -f
```

### backend-dev 利用

`backend-dev` は Backend 開発コマンド用です。`./backend` が container の `/app` に mount されます。

```bash
docker compose run --rm backend-dev gofmt -w .
docker compose run --rm backend-dev go test ./...
docker compose run --rm backend-dev go build -o /tmp/gotalk-backend .
```

`backend-dev` は port を公開していません。API server として通常起動する service は `backend` です。

## 5. 動作確認

### Frontend

ブラウザで Frontend を確認します。

```text
http://localhost:5173
```

### Backend health

Backend の health check を確認します。

```bash
curl http://localhost:8080/health
```

Response:

```json
{"status":"ok"}
```

### 翻訳 API

`/api/translate` は JSON request を受け取り、翻訳、バックトランスレーション、TTS 用テキストを JSON で返します。

```bash
curl -s http://localhost:8080/api/translate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "こんにちは",
    "languages": [
      { "id": "ja", "label": "Japanese" },
      { "id": "en", "label": "English" }
    ],
    "sourceLanguage": "ja"
  }'
```

`OPENAI_API_KEY` が未設定の場合、翻訳 API は `translation service unavailable` を返します。

### TTS

`/api/tts` は JSON request を受け取り、成功時に `audio/mpeg` を返します。

```bash
curl -s http://localhost:8080/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello"}' \
  -o /tmp/gotalk-tts.mp3
```

`OPENAI_API_KEY` が未設定の場合、TTS API は `service unavailable` を返します。

## 6. Backend 開発

Backend の通常起動 service は `backend` です。Backend の開発コマンドは `backend-dev` で実行できます。

Format:

```bash
docker compose run --rm backend-dev gofmt -w .
```

Test:

```bash
docker compose run --rm backend-dev go test ./...
```

Build:

```bash
docker compose run --rm backend-dev go build -o /tmp/gotalk-backend .
```

ホスト上で実行する場合:

```bash
cd backend
gofmt -w .
go test ./...
go build -o /tmp/gotalk-backend .
```

Backend は `:8080` で HTTP server を起動します。`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`DEBUG_TRANSLATION` は `backend/main.go` で参照されます。

## 7. Frontend 開発

Frontend は `frontend` service で Vite dev server として起動します。Compose では `./frontend:/app` と `/app/node_modules` が mount されます。

ホスト上で Frontend コマンドを実行する場合:

```bash
cd frontend
npm install
```

Test:

```bash
npm test
```

Build:

```bash
npm run build
```

その他、`frontend/package.json` には `npm run dev`、`npm run lint`、`npm run test:watch`、`npm run test:coverage`、`npm run preview` が定義されています。

## 8. 注意点

- 音声データは Backend に送信しません。Frontend の `SpeechRecognition` / `webkitSpeechRecognition` が音声をテキスト化し、Backend には認識済みテキストを送ります。
- Backend API は `/health`、`/api/translate`、`/api/tts` です。
- TTS は Backend の `/api/tts` から OpenAI Audio Speech API を呼び出し、`audio/mpeg` を返します。
- `http://localhost:5173/#tts-test` を開くと TTS テスト専用の `TtsTestPage` が表示されます。通常の利用画面とは独立した開発確認用ページです。

## 関連ドキュメント

- [architecture.md](architecture.md)
- [docker.md](docker.md)
