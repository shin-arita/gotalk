# Development

## 基本方針

GoTalk の標準開発環境は Docker Compose です。frontend/backend をまとめて起動し、ローカルでも VPS と近い実行単位で確認します。

ホスト上で frontend または backend を個別に lint、test、build、run する場合は、Node.js 22 または Go 1.22 が必要です。

## 前提

Docker Compose で起動する場合:

- Docker
- Docker Compose
- OpenAI API キー

ホスト上で個別実行する場合:

- Frontend: Node.js 22
- Backend: Go 1.22

## 環境変数

`.env.example` をコピーして `.env` を作成します。

```bash
cp .env.example .env
```

`.env` に OpenAI API キーを設定します。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | OpenAI API キー |
| `OPENAI_MODEL` | no | 翻訳に使用するモデル。未設定時は `gpt-4o-mini` |

## 1. Docker Compose で起動

```bash
docker compose up -d --build
```

起動するサービス:

| Service | Container | Port | 内容 |
| --- | --- | --- | --- |
| frontend | `gotalk-frontend` | `5173:5173` | Vite dev server |
| backend | `gotalk-backend` | `8080:8080` | Go API server |

起動後の URL:

| URL | 用途 |
| --- | --- |
| http://localhost:5173 | Frontend |
| http://localhost:8080/health | Backend health check |

frontend コンテナでは `VITE_BACKEND_URL=http://backend:8080` を設定しています。Vite の proxy により、frontend からの `/api` リクエストは backend コンテナへ転送されます。

## ログ確認

```bash
docker compose logs -f
```

## 停止

```bash
docker compose down
```

## 2. Frontend を個別に起動

ホスト上で frontend を直接起動する場合は Node.js 22 が必要です。

```bash
cd frontend
npm ci
npm run dev
```

frontend は Vite dev server として起動します。`/api` の proxy 先は `VITE_BACKEND_URL` があればその値、未設定時は `http://localhost:8080` です。

## 3. Backend を個別に起動

ホスト上で backend を直接起動する場合は Go 1.22 が必要です。

```bash
cd backend
go run .
```

Backend は `:8080` で起動します。

## 個別検証コマンド

Frontend:

```bash
cd frontend
npm run lint
npm run test
npm run test:coverage
npm run build
```

Backend:

```bash
cd backend
go vet ./...
go test ./...
go build -o /tmp/gotalk-backend .
```
