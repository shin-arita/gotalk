# CI/CD

## 1. 概要

GoTalk は GitHub Actions で CI、CD、Codex Review ラベル運用を行います。

現在存在する workflow は次の 3 つです。

- `.github/workflows/ci.yml`
- `.github/workflows/cd.yml`
- `.github/workflows/codex-review-request.yml`

Pull Request では CI とレビューを行い、`main` へ merge された変更は `push` to `main` として CD workflow に流れます。`main` への push では CI も起動しますが、CD は CI の完了を条件にしていない（`needs` や `workflow_run` による依存がない）ため、CI と CD は並行して動きます。CD の deploy job は GitHub Environment `production` を指定しているため、GitHub 側で Required reviewers が設定されている場合は、承認されるまで VPS への SSH 接続と Docker Compose による更新は実行されません。

```mermaid
flowchart LR
  Feature[feature branch] --> Commit[commit]
  Commit --> Push[push]
  Push --> PR[Pull Request]
  PR --> CI[CI<br/>frontend / backend]
  PR --> ReviewRequest["@codex review"]
  ReviewRequest --> ReviewPending[review-pending]
  ReviewPending --> Codex[Codex Review]
  Codex --> Ready[merge-ready]
  Codex --> Blocked[merge-blocked]
  Ready --> Merge[merge to main]
  CI --> Merge
  Merge --> CIMain[CI<br/>push to main]
  Merge --> CD[CD<br/>push to main]
  CD --> Approval[production Environment<br/>Required reviewers 設定時は承認待ち]
  Approval --> VPS[VPS deploy<br/>docker compose up -d --build]
```

## 2. CI

CI は `.github/workflows/ci.yml` で定義されています。

Trigger:

- `push` to `main`
- `pull_request`

### Frontend

Frontend job は `frontend` directory で実行されます。

| 項目 | 内容 |
| --- | --- |
| runner | `ubuntu-latest` |
| action | `actions/checkout@v7`、`actions/setup-node@v7` |
| Node.js | `22` |
| cache | `npm`、`frontend/package-lock.json` |
| install | `npm ci` |
| lint | `npm run lint` |
| test | `npm run test` |
| coverage | `npm run test:coverage` |
| build | `npm run build` |

### Backend

Backend job は `backend` directory で実行されます。

| 項目 | 内容 |
| --- | --- |
| runner | `ubuntu-latest` |
| action | `actions/checkout@v7`、`actions/setup-go@v7` |
| Go | `setup-go` の `go-version: "1.24"` と `check-latest: true`（1.24 系の最新パッチ） |
| cache | `backend/go.sum` |
| gofmt | `gofmt -l .` の結果が空でなければ失敗 |
| vet | `go vet ./...` |
| test | `go test ./...` |
| build | `go build -o /tmp/gotalk-backend .` |

Go のバージョンは次のように決まります。

| 対象 | 指定 | 使われる Go |
| --- | --- | --- |
| CI | `setup-go` の `go-version: "1.24"` と `check-latest: true` | CI の実行時点での 1.24 系の最新パッチ |
| Docker build（本番を含む） | `backend/Dockerfile` の `golang:1.24-alpine` | build の時点で `golang:1.24-alpine` が指している 1.24 系の最新パッチ |
| `backend/go.mod` | `go 1.24.0` | 必要な最低バージョン。CI と Docker のどちらのパッチもこれを満たす |

CI と本番の Docker build は、どちらも 1.24 系の最新パッチを使います。ただし、CI の実行と本番の build の時点が異なる場合や、`golang:1.24-alpine` の更新が新しいパッチのリリースより遅れる場合は、CI と本番でパッチバージョンが一時的に異なることがあります。

`ci.yml` の各 action（`actions/checkout@v7`、`actions/setup-node@v7`、`actions/setup-go@v7`）は、Node.js 24 で動くメジャーバージョンです。

`go vet` の前に gofmt の確認 step を実行します。`gofmt -l .` が整形されていないファイルを 1 件でも表示した場合は、そのファイル名を出力して job を失敗させます。

## 3. CD

CD は `.github/workflows/cd.yml` で定義されています。

| 項目 | 内容 |
| --- | --- |
| Trigger | `push` to `main` |
| job | `deploy` |
| runner | `ubuntu-latest` |
| environment | `production` |
| deploy target | VPS |
| deploy method | SSH 経由で VPS 上の repository を更新し、Docker Compose を起動 |

`deploy` job は `environment: production` を指定しています。GitHub Environment 側で Required reviewers が設定されている場合、承認されるまで VPS への deploy は実行されません。

VPS への SSH 接続には `appleboy/ssh-action@v1.2.2` を使います。参照する GitHub Secrets は次のとおりです。

| Secret | 用途 |
| --- | --- |
| `VPS_HOST` | VPS host |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | SSH private key |

VPS 上で実行する deploy script:

```bash
set -e
cd ~/gotalk
git pull --ff-only
docker compose up -d --build
docker compose ps
```

deploy script の `docker compose up -d --build` はサービス名を指定していませんが、`backend-dev` には `profiles: ["dev"]` が付いているため対象にならず、`frontend` と `backend` だけを build・起動します。

## 4. GitHub Actions

現在存在する workflow は次のとおりです。

| ファイル名 | Trigger | 役割 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `push` to `main`、`pull_request` | Frontend の lint / test / coverage / build、Backend の gofmt / vet / test / build |
| `.github/workflows/cd.yml` | `push` to `main` | VPS に SSH 接続して Docker Compose で deploy。`production` Environment を指定しており、Required reviewers が設定されている場合は承認後に実行 |
| `.github/workflows/codex-review-request.yml` | `issue_comment` created、`pull_request` synchronize | `@codex review` request と Codex bot result に応じて PR label を更新 |

`codex-review-request.yml` は次の label を扱います。

| Label | 用途 |
| --- | --- |
| `review-pending` | Codex review 待ち |
| `merge-ready` | review 結果が merge 可能 |
| `merge-blocked` | review 結果が merge block |

`@codex review` を含む人間の PR comment では `review-pending` を追加し、`merge-ready` と `merge-blocked` を外します。Bot comment では本文の keyword から ready / blocked を判定し、`merge-ready` または `merge-blocked` を適用します。PR synchronize では `merge-ready` を外して `review-pending` を追加します。`merge-blocked` は synchronize では外しません。

## 5. 開発フロー

現在の運用フローは次のとおりです。

1. feature branch を作成する
2. Claude Code で実装、修正、テスト、ドキュメント更新を行う
3. commit する
4. branch を push する
5. Pull Request を作成する
6. GitHub Actions CI で Frontend / Backend の検証を行う
7. PR comment で `@codex review` を依頼する
8. Codex Review の結果に応じて `merge-ready` または `merge-blocked` label が付く
9. CI と review 結果を確認して merge する
10. `main` への push を trigger に CI と CD が並行して起動する
11. `production` Environment に Required reviewers が設定されている場合は承認後に、VPS に deploy する

## 6. 品質保証

品質保証は CI、テスト、build、Codex Review を組み合わせます。

Frontend:

- ESLint: `npm run lint`
- Vitest: `npm run test`
- coverage: `npm run test:coverage`
- TypeScript / Vite build: `npm run build`

Backend:

- Go vet: `go vet ./...`
- Go test: `go test ./...`
- Go build: `go build -o /tmp/gotalk-backend .`

Codex Review:

- PR 差分に対する review request を `@codex review` comment で開始する
- review request 中は `review-pending` を使う
- review 結果 comment に応じて `merge-ready` または `merge-blocked` を付ける
- PR 更新時は `merge-ready` を外し、再 review 待ちとして `review-pending` を付ける

## 7. デプロイ後確認

CD workflow は deploy script の最後で `docker compose ps` を実行します。

デプロイ後は VPS 上の Docker Compose service 状態と、Backend の health check を確認します。Backend health check は `/health` で `{"status":"ok"}` を返します。

## 8. 関連ドキュメント

- [development.md](development.md)
- [testing.md](testing.md)
- [architecture.md](architecture.md)
