# Infrastructure

## 概要

GoTalk は VPS 上で Docker Compose により frontend/backend を起動します。GitHub Actions CD から SSH で VPS に接続し、main ブランチの最新状態を pull して再ビルド、再起動します。

HTTPS、監視、バックアップは現時点では導入済みとして扱いません。これらは今後の本番運用強化項目です。

## VPS 構成

想定配置:

```text
~/gotalk
├── backend/
├── frontend/
├── docker-compose.yml
└── .env
```

CD workflow は VPS 上で `cd ~/gotalk` を実行するため、この配置を前提にしています。

## Docker Compose

`docker-compose.yml` では frontend と backend の 2 サービスを定義しています。

| Service | Container | Port | 役割 |
| --- | --- | --- | --- |
| frontend | `gotalk-frontend` | `5173:5173` | Vite dev server |
| backend | `gotalk-backend` | `8080:8080` | Go API server |

frontend には `VITE_BACKEND_URL=http://backend:8080` を設定しています。Vite の `/api` proxy が backend コンテナへリクエストを転送します。

backend には以下の環境変数を渡します。

```yaml
OPENAI_API_KEY: ${OPENAI_API_KEY}
OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4o-mini}
```

## 環境変数

VPS 側の `.env` に以下を設定します。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | OpenAI API キー |
| `OPENAI_MODEL` | no | 翻訳に使用するモデル。未設定時は `gpt-4o-mini` |

## デプロイ経路

```mermaid
flowchart LR
  Main[main push] --> Actions[GitHub Actions CD]
  Actions -->|SSH| VPS[VPS]
  VPS --> Pull[git pull --ff-only]
  Pull --> Compose[docker compose up -d --build]
  Compose --> App[gotalk-frontend / gotalk-backend]
```

## VPS 側の準備

- Docker / Docker Compose のインストール
- `~/gotalk` にリポジトリを clone
- `.env` に `OPENAI_API_KEY` を設定
- GitHub Actions から SSH 接続できる鍵を配置
- GitHub Secrets に `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` を登録

## 現在未実施の運用項目

- HTTPS / TLS 証明書の設定
- リバースプロキシの設定
- frontend の静的配信最適化
- デプロイ後ヘルスチェック
- ログ収集
- 監視とアラート
- バックアップ方針
