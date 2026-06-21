# Testing

## テスト戦略

GoTalk のテストは、フロントエンドとバックエンドを分けて検証し、Pull Request と main push のたびに GitHub Actions CI で自動実行します。

主な目的は以下です。

- 回帰防止: 言語定義、言語選択、録音開始、API 補助ロジックなど、現在テストしている既存機能が変更で壊れていないことを確認する
- CI 連携: ローカルだけでなく GitHub Actions 上でも同じ検証を実行し、レビュー前に機械的な問題を検出する
- 品質保証: lint、unit test、coverage、build を組み合わせ、実装品質とビルド可能性を確認する
- レビュー支援: Codex のレビュー時に、差分だけでなく CI 結果も判断材料にできる状態を作る

## テスト対象の考え方

Frontend では、現在は言語定義、言語選択画面、録音開始から停止までの基本的なイベントを検証しています。UI の見た目そのものではなく、選択状態、ボタン状態、イベントハンドラ呼び出しなど、コンポーネントの振る舞いを対象にしています。

Backend では、OpenAI API 呼び出しそのものではなく、ヘルスチェック、CORS、エラーレスポンス、JSON 抽出、言語判定補助ロジックなど、アプリケーション側で制御できるロジックを中心に検証しています。外部 API への依存を直接テストに含めないことで、CI 上でも安定して実行できる構成にしています。

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
