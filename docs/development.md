# Development

## 前提

- Docker / Docker Compose
- Node.js 22
- Go 1.22
- OpenAI API キー

Docker Compose で起動する場合、ホスト側に Node.js と Go がなくてもコンテナ上でアプリケーションを実行できます。個別に lint、test、build を実行する場合は Node.js と Go が必要です。

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

```bash
cd frontend
npm ci
npm run dev
```

## Backend を個別に起動

```bash
cd backend
go run .
```

Backend は `:8080` で起動します。

## GitHub 運用フロー

このリポジトリでは、AI コーディングツールを役割分担して使う前提で運用します。

- Claude Code: 実装担当
- Codex: レビュー担当
- GitHub Pull Request: 変更内容、CI 結果、レビュー指摘を集約する場

基本フロー:

1. Issue または作業メモで実装対象を明確化する
2. feature ブランチを作成する
3. Claude Code が実装する
4. Pull Request を作成する
5. GitHub Actions CI で lint / test / build を確認する
6. Codex が差分レビューを行う
7. 指摘対応後、main へマージする
8. main push をトリガーに VPS へ自動デプロイする

推奨ブランチ命名:

```text
feature/<topic>
fix/<topic>
docs/<topic>
```
