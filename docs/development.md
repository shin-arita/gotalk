# Development

## 1. 開発環境概要

GoTalk の標準開発環境は Docker Compose です。`docker-compose.yml` には次の 3 service が定義されています。

| Service | 役割 | Port | 主な用途 |
| --- | --- | --- | --- |
| `frontend` | React / TypeScript / Vite の開発サーバー | `127.0.0.1:5173:5173` | ブラウザ UI の起動 |
| `backend` | Go の API server | `127.0.0.1:8080:8080` | 文字起こし、翻訳、バックトランスレーション、TTS |
| `backend-dev` | Go 開発用コンテナ（`profiles: ["dev"]`） | なし | `gofmt`、`go test`、`go build` などの Backend 開発コマンド |

通常の動作確認では `frontend` と `backend` を起動します。`backend-dev` は通常運用で常時起動する service ではなく、Backend の開発コマンドを実行するために使います。

`frontend` と `backend` の `ports` は host の `127.0.0.1` だけに公開しています。開発中のマシンからは `http://localhost:5173` と `http://localhost:8080` でアクセスできますが、同じ LAN の別の端末（スマートフォンなど）から、開発中のマシンの LAN 側のアドレスで接続することはできません。macOS などで `localhost` が IPv6 の `::1` に先に解決される環境でも、curl やブラウザは `::1` への接続に失敗した後に `127.0.0.1` へ接続し直すため、`http://localhost:5173` と `http://localhost:8080` はこれまでどおり使えます。`http://[::1]:8080` のように IPv6 のアドレスを直接指定した場合は接続できません。`localhost` を IPv4 にフォールバックしないツールでは、`127.0.0.1` を指定してください。

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

`.env` を読むのは Docker Compose の変数置換だけで、Backend 自身は `.env` を読み込みません（`backend/main.go` は `os.Getenv` で環境変数を読むだけです）。`docker-compose.yml` は `.env` の値のうち `OPENAI_API_KEY` と `OPENAI_MODEL` を `backend` と `backend-dev` に渡します。`OPENAI_MODEL` は未設定の場合、Compose で `gpt-4o-mini` が渡されます。

`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL` は `docker-compose.yml` が backend に渡していないため、`.env` に書いても、どの起動方法でも反映されません。これらはホスト上で Backend を直接実行する場合に、シェルの環境変数として渡したときだけ反映されます（6 章を参照）。`.env.example` ではこの 3 つをコメントアウトして記載しています。

Image を build します。

```bash
docker compose build
```

`frontend` と `backend` を起動します。

```bash
docker compose up frontend backend
```

background で起動する場合は次を使います。

```bash
docker compose up -d frontend backend
```

`backend-dev` には `profiles: ["dev"]` が付いているため、サービス名を指定しない `docker compose up` でも `backend-dev` は build・起動の対象にならず、`frontend` と `backend` だけが起動します。

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

`backend-dev` は Backend 開発コマンド用です。`./backend` が container の `/app` に mount されます。`backend-dev` は `profiles: ["dev"]` に属していますが、`docker compose run` でサービス名を指定すれば `--profile` を付けずに実行できます。

`backend-dev` は既定のコマンドを持たないため、`docker compose run` では必ず実行するコマンドを指定してください。`docker compose up` では使えません（`--profile dev` を付けた場合や `COMPOSE_PROFILES=dev` を設定した場合も含めて失敗します）。理由と失敗する操作の詳細は [docker.md](docker.md) の「6. backend-dev」を参照してください。

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
    ]
  }'
```

`OPENAI_API_KEY` が未設定の場合、翻訳 API は `translation service unavailable` を返します。

### 確定翻訳 API

`/api/interpret` は `multipart/form-data` で録音音声と言語情報を受け取り、原文、翻訳、バックトランスレーション、TTS 用テキストを JSON で返します。`transcript` を付けた場合は、そのテキストを `speaker` の言語から翻訳します。

```bash
curl -s http://localhost:8080/api/interpret \
  -F "audio=@recording.webm" \
  -F 'myLanguage={"id":"ja","label":"Japanese"}' \
  -F 'theirLanguage={"id":"en","label":"English"}' \
  -F "speaker=ja" \
  -F "transcript=こんにちは"
```

`transcript` を付けない場合は、Backend が `audio` の音声を OpenAI の音声文字起こし API に送り、言語判定と文字起こしを行ってから翻訳します。`audio` は `transcript` の有無にかかわらず必須です。

`OPENAI_API_KEY` が未設定の場合、確定翻訳 API は `service unavailable` を返します。

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

Backend は `:8080` で HTTP server を起動します。`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL`、`DEBUG_TRANSLATION` は `backend/main.go` で `os.Getenv` により参照されます。

Backend は `.env` を読み込まないため、ホスト上で Backend を起動する場合は、必要な環境変数をシェルで渡します。

```bash
cd backend
export OPENAI_API_KEY=sk-...
# 必要に応じて設定します（未設定時は Backend の既定値を使います）
export OPENAI_MODEL=gpt-4o-mini
export OPENAI_TTS_MODEL=gpt-4o-mini-tts
export OPENAI_TTS_VOICE=marin
export WHISPER_MODEL=gpt-4o-transcribe
export DEBUG_TRANSLATION=true
go run .
```

`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL` を反映できるのは、この方法で起動した場合だけです。`DEBUG_TRANSLATION` は `true` のときだけ翻訳の debug log を出力し、未設定のときは出力しません。

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

- 録音音声は録音終了のたびに Backend の `/api/interpret` に送信します。Frontend の `SpeechRecognition` / `webkitSpeechRecognition` の認識テキストが得られた場合は `transcript` として同じリクエストに添え、Backend はそのテキストを翻訳します。得られなかった場合は Backend が OpenAI の音声文字起こし API で文字起こしします。
- Backend API は `/health`、`/api/tts`、`/api/interpret`、`/api/translate` の 4 本です。
- TTS は Backend の `/api/tts` から OpenAI Audio Speech API を呼び出し、`audio/mpeg` を返します。
- `http://localhost:5173/#tts-test` を開くと `TtsTestPage` が表示されます。ブラウザの `speechSynthesis`（Web Speech API の音声合成）で日本語とタイ語の発声、`getVoices()` の一覧、発声イベントのログを確認するための開発確認用ページです。Backend の `/api/tts` は使いません。通常の利用画面とは独立しています。

## 関連ドキュメント

- [architecture.md](architecture.md)
- [docker.md](docker.md)
