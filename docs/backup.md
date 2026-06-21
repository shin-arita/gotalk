# Backup

## 概要

GoTalk は、本番 VPS の復旧に必要な設定とデータを毎日バックアップします。バックアップは VPS ローカルに 14 世代保持し、Google Drive にも退避します。

## バックアップ対象

- `/etc/nginx`
- `/etc/letsencrypt`
- `/home/ubuntu/gotalk/.env`
- `/home/ubuntu/uptime-kuma/data`

## バックアップ対象外

- ソースコード
- README
- docs
- Dockerfile
- docker-compose.yml
- GitHub Actions
- アプリケーションログ
- nginx access/error log
- Docker log

対象外とする理由:

- GitHub で復元可能なものはバックアップ対象外とする
- ログは復旧に不要なため対象外とする

## 保存先

ローカル:

- `/home/ubuntu/backup/backups`

Google Drive:

- `gotalk-backup`

## スクリプト

- `/home/ubuntu/backup/backup.sh`
- `/home/ubuntu/backup/restore.sh`

## cron

```cron
0 3 * * * /home/ubuntu/backup/backup.sh >> /home/ubuntu/backup/backup.log 2>&1
30 3 * * * /usr/bin/rclone copy /home/ubuntu/backup/backups gdrive:gotalk-backup >> /home/ubuntu/backup/rclone.log 2>&1
```

## 復旧概要

1. 新 VPS を用意する
2. GitHub から GoTalk を clone する
3. Google Drive の `gotalk-backup` から対象世代のバックアップを取得する
4. `/home/ubuntu/backup/restore.sh YYYYMMDD` を実行する
5. `sudo nginx -t` で nginx 設定を確認する
6. `sudo systemctl reload nginx` を実行する
7. `/home/ubuntu/uptime-kuma` で `docker compose restart` を実行する
8. `/home/ubuntu/gotalk` で `docker compose up -d` を実行する

## 注意事項

- `.env` には秘密情報が含まれるため Git 管理しない
- `rclone.conf` には Google Drive 認証情報が含まれるため Git 管理しない
- 実バックアップファイルは Git 管理しない
- 復旧時は `sudo nginx -t` を必ず確認する
- Google Drive 側のバックアップは `gotalk-backup` 配下に保存する
- ログはバックアップ対象外とする
