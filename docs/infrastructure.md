# Infrastructure

## 1. 概要

GoTalk は VPS 上で Docker Compose により `frontend` と `backend` を起動します。GitHub Actions の CD workflow は、`main` への push で起動した CI が成功した場合に起動し、SSH で VPS に接続して repository を CI が検証したコミットに更新します。CD の deploy job は `production` Environment を指定しているため、GitHub 側で Required reviewers が設定されている場合は、承認されるまで deploy は実行されません。

Backend は OpenAI API キーをサーバー側で扱い、OpenAI Audio Transcriptions API、OpenAI Responses API、OpenAI Audio Speech API へ outbound 接続します。Frontend は Backend の `/api` にリクエストし、Backend が文字起こし、翻訳、バックトランスレーション、TTS を実行します。

## 2. サーバー構成

本番 VPS では repository を `~/gotalk` に配置する前提です。CD workflow は VPS 上で `cd ~/gotalk` を実行します。

```text
~/gotalk
├── backend/
├── frontend/
├── docker-compose.yml
└── .env
```

Docker Compose の主な service は次のとおりです。

| Service | Container | Port | 役割 |
| --- | --- | --- | --- |
| `frontend` | `gotalk-frontend` | `127.0.0.1:5173:5173` | Vite dev server |
| `backend` | `gotalk-backend` | `127.0.0.1:8080:8080` | Go API server |

`frontend` と `backend` の `ports` は、VPS の IPv4 の loopback アドレス（`127.0.0.1`）だけに公開しています。すべての IPv4 のアドレス（`0.0.0.0`）にも、IPv6 のアドレス（`[::]` を含む）にも公開しません。そのため、VPS の外から `5173` と `8080` には直接接続できない構成です。ただし、これには Docker Engine のバージョンの前提があります（3 章の「ポートの公開範囲の前提」を参照）。

`docker-compose.yml` には `backend-dev` も定義されていますが、これは Backend 開発用 container です。通常運用で公開 port を持つ service ではありません。`backend-dev` には `profiles: ["dev"]` が付いているため、サービス名を指定しない `docker compose up` では起動しません。

## 3. ネットワーク構成

公開環境では HTTPS で GoTalk にアクセスできる状態です。ドメインと HTTPS の終端設定は repository の `docker-compose.yml` には含まれていません。HTTPS は VPS 上の nginx が終端します。nginx の設定はリポジトリの外（VPS の `/etc/nginx`）にあり、運用上の関連設定はバックアップ対象として `/etc/nginx` と `/etc/letsencrypt` に含まれます。

VPS の nginx の設定で確認している転送先は次のとおりです。

| nginx の location | 転送先 |
| --- | --- |
| `/` | `http://127.0.0.1:5173`（`frontend`） |
| `/api/` | `http://127.0.0.1:8080/api/`（`backend`） |

nginx の転送先は `127.0.0.1` で、Docker Compose の `ports` も `127.0.0.1` だけに公開しています。そのため、外からは HTTPS の nginx 経由でだけ GoTalk に届き、`5173` と `8080` に直接は届かない構成です（下の「ポートの公開範囲の前提」の条件を満たす場合）。

```mermaid
flowchart LR
  User[User Browser] -->|HTTPS / domain| Nginx[nginx<br/>HTTPS 終端]
  Internet[Internet] -.->|:5173 / :8080 直接は届かない<br/>Docker Engine 28.0.0 以上が前提| VPSHost[VPS の外向きアドレス]
  Nginx -->|/ → http://127.0.0.1:5173| Frontend[frontend<br/>gotalk-frontend<br/>127.0.0.1:5173]
  Nginx -->|/api/ → http://127.0.0.1:8080/api/| Backend[backend<br/>gotalk-backend<br/>127.0.0.1:8080]
  Frontend -->|/api proxy<br/>http://backend:8080| Backend
  Backend -->|HTTPS| OpenAI[OpenAI API<br/>Responses API / Audio Transcriptions API / Audio Speech API]

  subgraph VPS[VPS]
    Nginx
    VPSHost
    subgraph Compose[Docker Compose]
      Frontend
      Backend
    end
  end
```

Compose 内では `frontend` と `backend` が default network 上で service 名により接続します。`frontend` には `VITE_BACKEND_URL=http://backend:8080` が設定され、Vite proxy 経由で Backend に接続します。

Backend は OpenAI API へ HTTPS で outbound 接続します。

### ポートの公開範囲の前提

`5173` と `8080` に外から直接届かないことは、次の 2 点を前提にしています。

| 前提 | 内容 |
| --- | --- |
| Docker Engine が 28.0.0 以上であること | Docker のドキュメント（Port publishing and mapping）には、28.0.0 より前のリリースでは、同じ L2 のセグメントにあるホスト（同じネットワークスイッチにつながったホストなど）から、localhost に公開したポートに届く、という警告があります（[moby/moby#45610](https://github.com/moby/moby/issues/45610)）。VPS では、VPS の事業者のネットワーク上の他のホストがこれに当たる可能性があります。28.0.0 より前のバージョンの場合は、Docker Engine を更新するか、ホストの firewall（Docker の `DOCKER-USER` チェーンなど）で `5173` と `8080` への外からのアクセスを塞ぐ必要があります |
| `docker-compose.yml` の `ports` に `127.0.0.1` を指定していること | 外からのアクセスを塞いでいるのは、この `127.0.0.1` の指定です。ufw ではありません（次の段落） |

VPS の Docker Engine の現在のバージョンは、リポジトリからは確認できません。VPS で `docker version` を実行して確認します。

Docker のドキュメント（Packet filtering and firewalls の「Docker and ufw」）にあるとおり、Docker が公開したポートへの通信は `nat` テーブルで転送されます。そのため、ufw が使う `INPUT` と `OUTPUT` のチェーンに届く前に処理され、ufw の規則は効きません。以前、外から `5173` と `8080` に直接届いていたのも、`ports` が `0.0.0.0` と `[::]` に公開していたためで、ufw の設定にかかわらず届いていたと考えられます。VPS の ufw の現在の設定は、リポジトリからは確認できません。`ports` を変更するときは、ufw で塞いでいるつもりでも外に公開されることがあるため、`127.0.0.1` の指定を外さないよう注意してください。

## 4. デプロイ構成

CD は `.github/workflows/cd.yml` で定義されています。

| 項目 | 内容 |
| --- | --- |
| Trigger | `workflow_run`（`CI` の完了、`main`。CI が成功した場合だけ deploy）、`workflow_dispatch`（手動） |
| GitHub Environment | `production` |
| concurrency | `deploy` job に group `cd-production`（deploy を同時に実行しない） |
| 接続方式 | SSH |
| GitHub Action | `appleboy/ssh-action` v1.2.2（コミットの SHA `2ead5e36573f08b82fbfce1504f1a4b05a647c6f` で固定） |
| Deploy target | VPS |

CD workflow は次の GitHub Secrets を使います。

| Secret | 用途 |
| --- | --- |
| `VPS_HOST` | VPS host |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | SSH private key |

VPS 上で実行される deploy script です。`TARGET_SHA` には CI が検証したコミットが入り、`appleboy/ssh-action` の `envs` で環境変数として渡されます。

```bash
# TARGET_SHA は appleboy/ssh-action の envs で環境変数として渡される
set -e
cd ~/gotalk
if ! printf '%s' "$TARGET_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "Invalid TARGET_SHA: $TARGET_SHA"
  exit 1
fi
git fetch origin main
if ! git merge-base --is-ancestor HEAD "$TARGET_SHA"; then
  echo "Current HEAD $(git rev-parse HEAD) is not an ancestor of $TARGET_SHA; refusing to deploy"
  exit 1
fi
git merge --ff-only "$TARGET_SHA"
if [ "$(git rev-parse HEAD)" != "$TARGET_SHA" ]; then
  echo "HEAD $(git rev-parse HEAD) does not match $TARGET_SHA"
  exit 1
fi
docker compose build --pull
docker compose up -d
docker compose ps
```

`git fetch origin main` の後、VPS の現在のコミットが `TARGET_SHA` の祖先であることを確認し、`git merge --ff-only` で `TARGET_SHA` まで fast-forward します。`origin/main` がさらに進んでいても、CI が検証していないコミットは反映しません。新しいコミットがすでに反映されている場合は、古いコミットへ戻さずに失敗します。その後、`docker compose build --pull` で base image を pull してから image を build し、`docker compose up -d` で service を更新します。最後に `docker compose ps` で service 状態を表示します。

`docker compose build --pull` と `docker compose up -d` はサービス名を指定していませんが、`backend-dev` には `profiles: ["dev"]` が付いているため対象にならず、`frontend` と `backend` だけを pull・build・起動します。

手動で再 deploy する場合は、CD の run の Re-run か、CD workflow の `workflow_dispatch`（`main` から実行）を使います。VPS では手作業で `git pull` をしないでください。CI が成功していないコミットまで作業ツリーが進むためです。手作業でコミットを合わせる必要がある場合は、CI が成功したコミットを指定して `git merge --ff-only <SHA>` を実行します。build や pull で失敗した場合は、失敗した CD の run を Re-run すれば build から再実行でき、それまでのコンテナは動き続けます。詳細は [ci-cd.md](ci-cd.md) を参照してください。

## 5. 環境変数

現在利用している環境変数は次のとおりです。

| 環境変数 | 設定箇所 | 用途 | 未設定時 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Compose が `backend`、`backend-dev` に `${OPENAI_API_KEY}` を渡す | Backend から OpenAI API を呼び出すための API key | `/api/tts`、`/api/interpret` は HTTP 500 `service unavailable`、`/api/translate` は HTTP 500 `translation service unavailable` を返す |
| `OPENAI_MODEL` | Compose が `backend`、`backend-dev` に `${OPENAI_MODEL:-gpt-4o-mini}` を渡す（`.env` などで未設定なら `gpt-4o-mini`） | 翻訳とバックトランスレーションに使う model | `gpt-4o-mini` |
| `DEBUG_TRANSLATION` | Compose が `backend` に `true` を渡す（`backend-dev` には渡さない） | 翻訳 debug log の出力制御。`true` のときだけ出力する | debug log を出力しない |
| `VITE_BACKEND_URL` | Compose が `frontend` に `http://backend:8080` を渡す | Vite proxy の Backend 接続先 | `http://localhost:8080`（`frontend/vite.config.ts`） |
| `OPENAI_TTS_MODEL` | Compose では渡さない。ホスト上で Backend を直接実行するときのシェルの環境変数だけ | TTS model | `gpt-4o-mini-tts` |
| `OPENAI_TTS_VOICE` | Compose では渡さない。ホスト上で Backend を直接実行するときのシェルの環境変数だけ | TTS voice | `marin` |
| `WHISPER_MODEL` | Compose では渡さない。ホスト上で Backend を直接実行するときのシェルの環境変数だけ | `/api/interpret` で音声を文字起こしする model | `gpt-4o-transcribe` |

「未設定時」の列は、アプリケーションが環境変数を受け取らなかったときの動作です。

VPS 側の `.env` には少なくとも `OPENAI_API_KEY` を設定します。`OPENAI_MODEL` は `docker-compose.yml` で default が定義されています。

`.env` を読むのは Docker Compose の変数置換だけで、Backend 自身は `.env` を読み込みません（`backend/main.go` は `os.Getenv` で環境変数を読むだけです）。`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL` は `docker-compose.yml` が backend に渡していないため、`.env` に書いても、どの起動方法でも反映されず、Backend 実装の未設定時の default が使われます。これらはホスト上で Backend を直接実行する場合（開発時）に、シェルの環境変数として渡したときだけ反映されます（[development.md](development.md) を参照）。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

`.env` はバックアップ対象です。詳細は [backup.md](backup.md) を参照してください。

## 6. ログ確認

アプリケーション service の状態確認とログ確認は Docker Compose を中心に行います。

Service 状態:

```bash
docker compose ps
```

全 service のログ:

```bash
docker compose logs -f
```

Backend のログ:

```bash
docker compose logs -f backend
```

Frontend のログ:

```bash
docker compose logs -f frontend
```

`DEBUG_TRANSLATION=true` の場合、Backend は翻訳処理の debug log を出力します。

## 7. 関連ドキュメント

- [architecture.md](architecture.md)
- [docker.md](docker.md)
- [ci-cd.md](ci-cd.md)
- [backup.md](backup.md)
