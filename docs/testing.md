# Testing

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
| `npm run test:coverage` | coverage 付きテスト |
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

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/health
```

`/health` が `{"status":"ok"}` を返せば、backend の基本起動は成功です。

## CI で実行される検証

Pull Request と main push では GitHub Actions により以下が自動実行されます。

- Frontend lint
- Frontend test
- Frontend coverage
- Frontend build
- Backend vet
- Backend test
- Backend build
