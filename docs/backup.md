# Backup

## 1. 概要

GoTalk のバックアップ方針は、GitHub Repository をソースコードとドキュメントの正本とし、VPS 固有の設定と運用データをバックアップする構成です。

VPS 側のバックアップは毎日実行し、VPS ローカルに 14 世代保持します。バックアップは Google Drive の `gotalk-backup` にも退避します。

## 2. バックアップ対象

### GitHub Repository

次のものは GitHub Repository を正本として扱います。

| 対象 | 保管場所 | 備考 |
| --- | --- | --- |
| ソースコード | GitHub Repository | `backend/`、`frontend/` |
| Docker Compose | GitHub Repository | `docker-compose.yml` |
| Dockerfile | GitHub Repository | `backend/Dockerfile`、`backend/Dockerfile.dev`、`frontend/Dockerfile` |
| GitHub Actions | GitHub Repository | `.github/workflows/**` |
| ドキュメント | GitHub Repository | `docs/**`、`README.md` |

GitHub で復元できるものは、VPS バックアップ対象には含めません。

### VPS

現在の VPS バックアップ対象は次のとおりです。

| 対象 | 用途 |
| --- | --- |
| `/etc/nginx` | 公開 endpoint、domain、HTTPS 終端に関係する nginx 設定 |
| `/etc/letsencrypt` | HTTPS 証明書関連 |
| `/home/ubuntu/gotalk/.env` | GoTalk の本番環境変数 |
| `/home/ubuntu/uptime-kuma/data` | Uptime Kuma の運用データ |

`.env` には `OPENAI_API_KEY` などの秘密情報が含まれるため Git 管理せず、VPS バックアップ対象として扱います。

## 3. GitHub

GitHub Repository は GoTalk のソースコード、Docker 構成、CI/CD 設定、ドキュメントの正本です。

運用上の位置付け:

- `main` branch が CD workflow の deploy 元になる
- feature branch で変更し、Pull Request で CI と review を通す
- Pull Request merge 後の `push` to `main` で CD workflow が起動する
- VPS では `~/gotalk` で `git pull --ff-only` を実行し、GitHub の最新状態に更新する

CD workflow は VPS 上で次を実行します。

```bash
set -e
cd ~/gotalk
git pull --ff-only
docker compose up -d --build
docker compose ps
```

## 4. VPS

VPS では GoTalk repository を `/home/ubuntu/gotalk` に配置する運用です。CD workflow 側では `cd ~/gotalk` を実行します。

VPS ローカルのバックアップ保存先:

```text
/home/ubuntu/backup/backups
```

Google Drive 側の退避先:

```text
gotalk-backup
```

バックアップ・復旧用 script:

```text
/home/ubuntu/backup/backup.sh
/home/ubuntu/backup/restore.sh
```

cron:

```cron
0 3 * * * /home/ubuntu/backup/backup.sh >> /home/ubuntu/backup/backup.log 2>&1
30 3 * * * /usr/bin/rclone copy /home/ubuntu/backup/backups gdrive:gotalk-backup >> /home/ubuntu/backup/rclone.log 2>&1
```

## 5. 復旧手順

復旧時の概要は次のとおりです。

1. 新しい VPS を用意する
2. GitHub Repository から GoTalk を clone する
3. Google Drive の `gotalk-backup` から対象世代のバックアップを取得する
4. `/home/ubuntu/backup/restore.sh YYYYMMDD` を実行する
5. `sudo nginx -t` で nginx 設定を確認する
6. `sudo systemctl reload nginx` を実行する
7. `/home/ubuntu/uptime-kuma` で `docker compose restart` を実行する
8. `/home/ubuntu/gotalk` で `docker compose build` を実行する
9. `/home/ubuntu/gotalk` で `docker compose up -d` を実行する
10. `docker compose ps` と Backend health check を確認する

Backend health check:

```bash
curl http://localhost:8080/health
```

期待 response:

```json
{"status":"ok"}
```

## 6. バックアップ対象外

現在の VPS バックアップ対象外は次のとおりです。

| 対象外 | 理由 |
| --- | --- |
| ソースコード | GitHub Repository から復元する |
| README | GitHub Repository から復元する |
| docs | GitHub Repository から復元する |
| Dockerfile | GitHub Repository から復元する |
| `docker-compose.yml` | GitHub Repository から復元する |
| GitHub Actions | GitHub Repository から復元する |
| アプリケーションログ | 現時点では復旧に不要 |
| nginx access/error log | 現時点では復旧に不要 |
| Docker log | 現時点では復旧に不要 |

実バックアップファイルと `rclone.conf` は Git 管理しません。`rclone.conf` には Google Drive 認証情報が含まれます。

## 7. 関連ドキュメント

- [development.md](development.md)
- [infrastructure.md](infrastructure.md)
- [ci-cd.md](ci-cd.md)
