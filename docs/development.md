# Development

## 前提

- Docker / Docker Compose
- OpenAI API キー

基本の開発手順は Docker Compose での起動です。ホスト上で frontend/backend を個別に lint、test、build、run する場合は、Node.js 22 と Go 1.22 が必要です。

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

## Docker Compose で起動

```bash
docker compose up -d --build
```

起動後の URL:

| URL | 用途 |
| --- | --- |
| http://localhost:5173 | Frontend |
| http://localhost:8080/health | Backend health check |

## ログ確認

```bash
docker compose logs -f
```

## 停止

```bash
docker compose down
```

## Frontend を個別に起動

ホスト上で frontend を直接起動する場合は Node.js 22 が必要です。

```bash
cd frontend
npm ci
npm run dev
```

## Backend を個別に起動

ホスト上で backend を直接起動する場合は Go 1.22 が必要です。

```bash
cd backend
go run .
```

Backend は `:8080` で起動します。
