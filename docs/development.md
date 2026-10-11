# Development

## 1. 開発環境概要

GoTalk の標準開発環境は Docker Compose です。`docker-compose.yml` には次の 3 service が定義されています。

| Service | 役割 | Port | 主な用途 |
| --- | --- | --- | --- |
| `frontend` | React / TypeScript / Vite の開発サーバー | `127.0.0.1:5173:5173` | ブラウザ UI の起動 |
| `backend` | Go の API server | `127.0.0.1:8080:8080` | 文字起こし、翻訳、バックトランスレーション、TTS |
| `backend-dev` | Go 開発用コンテナ（`profiles: ["dev"]`） | なし | `gofmt`、`go test`、`go build` などの Backend 開発コマンド |

通常の動作確認では `frontend` と `backend` を起動します。`backend-dev` は通常運用で常時起動する service ではなく、Backend の開発コマンドを実行するために使います。

`frontend` と `backend` の `ports` は host の `127.0.0.1` だけに公開しています。開発中のマシンからは `http://localhost:5173` と `http://localhost:8080` でアクセスできますが、同じ LAN の別の端末（スマートフォンなど）から、開発中のマシンの LAN 側のアドレスで接続することはできません（Docker Engine のバージョンなどの前提は [infrastructure.md の「ポートの公開範囲の前提」](infrastructure.md#ポートの公開範囲の前提) を参照）。macOS などで `localhost` が IPv6 の `::1` に先に解決される環境でも、curl やブラウザは `::1` への接続に失敗した後に `127.0.0.1` へ接続し直すため、`http://localhost:5173` と `http://localhost:8080` はこれまでどおり使えます。`http://[::1]:8080` のように IPv6 のアドレスを直接指定した場合は接続できません。`localhost` を IPv4 にフォールバックしないツールでは、`127.0.0.1` を指定してください。

### 実機（スマートフォンなど）での確認

LAN の `http://<開発中のマシンの IP>:5173` は、もともと音声機能の確認には使えませんでした。マイク（`getUserMedia`）は secure context（HTTPS か `localhost`）でしか使えず、LAN の IP アドレスへの HTTP は secure context にならないためです。

実機で音声機能を確認する場合は、開発中のマシン（ホスト）で cloudflared の tunnel を動かし、`127.0.0.1:5173` を origin にする方法が使えます。

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

表示された `https://<ランダムな名前>.trycloudflare.com` を実機のブラウザで開きます。HTTPS なのでマイクを使えます。`frontend/vite.config.ts` の `server.allowedHosts` に `.trycloudflare.com` が設定されているため、Vite の開発サーバーはこの host 名でのアクセスを受け付けます。`/api` は Vite の proxy で `backend` に転送されます。

cloudflared は、コンテナではなくホスト上で動かしてください。コンテナの中では `127.0.0.1` がそのコンテナ自身を指すため、ホストの `127.0.0.1:5173` には届きません。

この方法（Cloudflare の Quick Tunnel）で発行される URL には、次の注意があります。

- URL を知っている人は、誰でも開発サーバーにアクセスできます。`/api` も Vite の proxy で `backend` に転送されるため、開発者の `OPENAI_API_KEY` を使う Backend にも届きます。URL が漏れると、第三者のリクエストで OpenAI の利用料が発生する可能性があります。URL を共有しないでください
- 確認が終わったら、`cloudflared` を止めてください。Cloudflare のドキュメントにあるとおり、`cloudflared` のプロセスを止めると URL は使えなくなります
- アクセスできる人を制限したい場合は、Cloudflare のドキュメント（Quick Tunnels の「Restrict access by email」）にある `--allowed-mail` を使えます。指定したメールアドレスに届くワンタイム PIN で認証した人だけがアクセスできます。`--allowed-mail` をくり返し指定すると複数のアドレスを、`*@example.com` の形でドメインのすべてのアドレスを許可できます。この認証は対話的なブラウザでのアクセスが前提です
- `--allowed-mail` は cloudflared 2026.9.2 以降で使えます。Cloudflare のドキュメントには最低バージョンが書かれていませんが、cloudflared の `RELEASE_NOTES` の 2026.9.2 に「chore: Enable --allowed-mail flag and mac runners」とあります。また、2026.10.0 には「VULN-141859: Normalize request path when using access rules」（アクセスの規則を使うときのリクエストのパスの正規化）の修正が入っています。そのため、アクセスの制限に使う場合は 2026.10.0 以降を使ってください。`cloudflared --version` でバージョンを確認できます

```bash
cloudflared tunnel --url http://127.0.0.1:5173 --allowed-mail you@example.com
```

`frontend` には `VITE_BACKEND_URL=http://backend:8080` が設定されます。Vite の proxy により、Frontend からの `/api` request は Backend service に転送されます。

## 2. 必要ソフトウェア

Docker Compose で開発する場合に必要なものは次のとおりです。

- Docker
- Docker Compose
- OpenAI API キー

ホスト上で個別に Frontend / Backend コマンドを実行する場合は、次も必要です。

- Frontend: Node.js 22
- Backend: Go 1.24

Dockerfile では Frontend に `node:22-alpine`、Backend に `golang:1.24-alpine` を使っています。

## 3. 初回セットアップ

Repository を clone します。

```bash
git clone <repository-url>
cd gotalk
```

Repository root に `.env` を作成し、OpenAI API キーを設定します。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

`.env` を読むのは Docker Compose の変数置換だけで、Backend 自身は `.env` を読み込みません（`backend/main.go` は `os.Getenv` で環境変数を読むだけです）。`docker-compose.yml` は `.env` の値のうち `OPENAI_API_KEY` と `OPENAI_MODEL` を `backend` と `backend-dev` に渡します。`OPENAI_MODEL` は未設定の場合、Compose で `gpt-4o-mini` が渡されます。

`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL` は `docker-compose.yml` が backend に渡していないため、`.env` に書いても、どの起動方法でも反映されません。これらはホスト上で Backend を直接実行する場合に、シェルの環境変数として渡したときだけ反映されます（6 章を参照）。`.env.example` ではこの 3 つをコメントアウトして記載しています。

Image を build します。

```bash
docker compose build
```

`frontend` と `backend` を起動します。

```bash
docker compose up frontend backend
```

background で起動する場合は次を使います。

```bash
docker compose up -d frontend backend
```

`backend-dev` には `profiles: ["dev"]` が付いているため、サービス名を指定しない `docker compose up` でも `backend-dev` は build・起動の対象にならず、`frontend` と `backend` だけが起動します。

## 4. 起動方法

### 通常起動

通常のアプリケーション確認では `frontend` と `backend` を起動します。

```bash
docker compose up frontend backend
```

build も同時に行う場合:

```bash
docker compose up --build frontend backend
```

停止:

```bash
docker compose down
```

ログ確認:

```bash
docker compose logs -f
```

### backend-dev 利用

`backend-dev` は Backend 開発コマンド用です。`./backend` が container の `/app` に mount されます。`backend-dev` は `profiles: ["dev"]` に属していますが、`docker compose run` でサービス名を指定すれば `--profile` を付けずに実行できます。

`backend-dev` は既定のコマンドを持たないため、`docker compose run` では必ず実行するコマンドを指定してください。`docker compose up` では使えません（`--profile dev` を付けた場合や `COMPOSE_PROFILES=dev` を設定した場合も含めて失敗します）。理由と失敗する操作の詳細は [docker.md](docker.md) の「6. backend-dev」を参照してください。

```bash
docker compose run --rm backend-dev gofmt -w .
docker compose run --rm backend-dev go test ./...
docker compose run --rm backend-dev go build -o /tmp/gotalk-backend .
```

`backend-dev` は port を公開していません。API server として通常起動する service は `backend` です。

## 5. 動作確認

### Frontend

ブラウザで Frontend を確認します。

```text
http://localhost:5173
```

### Backend health

Backend の health check を確認します。

```bash
curl http://localhost:8080/health
```

Response:

```json
{"status":"ok"}
```

### 翻訳 API

`/api/translate` は JSON request を受け取り、翻訳、バックトランスレーション、TTS 用テキストを JSON で返します。

```bash
curl -s http://localhost:8080/api/translate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "こんにちは",
    "languages": [
      { "id": "ja", "label": "Japanese" },
      { "id": "en", "label": "English" }
    ]
  }'
```

`OPENAI_API_KEY` が未設定の場合、翻訳 API は `translation service unavailable` を返します。

### 確定翻訳 API

`/api/interpret` は `multipart/form-data` で録音音声と言語情報を受け取り、原文、翻訳、バックトランスレーション、TTS 用テキストを JSON で返します。`transcript` を付けた場合は、そのテキストを `speaker` の言語から翻訳します。

```bash
curl -s http://localhost:8080/api/interpret \
  -F "audio=@recording.webm" \
  -F 'myLanguage={"id":"ja","label":"Japanese"}' \
  -F 'theirLanguage={"id":"en","label":"English"}' \
  -F "speaker=ja" \
  -F "transcript=こんにちは"
```

`transcript` を付けない場合は、Backend が `audio` の音声を OpenAI の音声文字起こし API に送り、言語判定と文字起こしを行ってから翻訳します。`audio` は `transcript` の有無にかかわらず必須です。

`OPENAI_API_KEY` が未設定の場合、確定翻訳 API は `service unavailable` を返します。

### TTS

`/api/tts` は JSON request を受け取り、成功時に `audio/mpeg` を返します。

```bash
curl -s http://localhost:8080/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello"}' \
  -o /tmp/gotalk-tts.mp3
```

`OPENAI_API_KEY` が未設定の場合、TTS API は `service unavailable` を返します。

## 6. Backend 開発

Backend の通常起動 service は `backend` です。Backend の開発コマンドは `backend-dev` で実行できます。

Format:

```bash
docker compose run --rm backend-dev gofmt -w .
```

Test:

```bash
docker compose run --rm backend-dev go test ./...
```

Build:

```bash
docker compose run --rm backend-dev go build -o /tmp/gotalk-backend .
```

ホスト上で実行する場合:

```bash
cd backend
gofmt -w .
go test ./...
go build -o /tmp/gotalk-backend .
```

Backend は `:8080` で HTTP server を起動します。`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL`、`DEBUG_TRANSLATION` は `backend/main.go` で `os.Getenv` により参照されます。

Backend は `.env` を読み込まないため、ホスト上で Backend を起動する場合は、必要な環境変数をシェルで渡します。

```bash
cd backend
export OPENAI_API_KEY=sk-...
# 必要に応じて設定します（未設定時は Backend の既定値を使います）
export OPENAI_MODEL=gpt-4o-mini
export OPENAI_TTS_MODEL=gpt-4o-mini-tts
export OPENAI_TTS_VOICE=marin
export WHISPER_MODEL=gpt-4o-transcribe
# 翻訳の debug log が必要なときだけ設定します（下の「Backend の debug log」を参照）
# export DEBUG_TRANSLATION=true
go run .
```

`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE`、`WHISPER_MODEL` を反映できるのは、この方法で起動した場合だけです。

### Backend の debug log

`DEBUG_TRANSLATION=true` のときだけ、Backend は翻訳処理の debug log（`[DEBUG_TRANSLATION]` で始まる行）を出力します。未設定や `true` 以外の値のときは出力しません。

debug log には、受信したテキスト、翻訳 prompt、OpenAI の応答、固有名詞の保護マップなど、発話の内容がそのまま含まれます。ローカルでの調査のときだけ使い、本番では有効にしないでください。通常のログに出力する情報は [infrastructure.md](infrastructure.md) の「Backend のログに出力する情報」を参照してください。

`docker-compose.yml` は `DEBUG_TRANSLATION` を `backend` に渡していません。そのため、`.env` に `DEBUG_TRANSLATION=true` を書いても `backend` には渡らず、debug log は出力されません。ローカルで有効にする方法は次のどちらかです。

1. ホストで Backend を直接実行する場合は、上の例のように、シェルで `export DEBUG_TRANSLATION=true` を設定してから `go run .` を実行します
2. Docker Compose で動かす場合は、リポジトリにコミットしない一時的な override ファイルで渡します

```bash
cat > /tmp/gotalk-debug.yml <<'YAML'
services:
  backend:
    environment:
      - DEBUG_TRANSLATION=true
YAML
docker compose -f docker-compose.yml -f /tmp/gotalk-debug.yml up -d
docker compose logs -f backend
```

override ファイルは、`docker-compose.override.yml` などの名前でリポジトリのディレクトリ（`docker-compose.yml` と同じディレクトリ）に置かないでください。Compose は、`-f` を指定しない場合、`docker-compose.yml` と同じディレクトリにある override ファイルを自動で読み込みます（Docker のドキュメント「Merge Compose files」。手元の Docker Compose v5.1.0 では、`docker-compose.override.yml`、`docker-compose.override.yaml`、`compose.override.yml`、`compose.override.yaml` のどれも自動で読み込まれることを確認しました）。消し忘れると、`DEBUG_TRANSLATION` が有効なまま起動します。これらのファイル名は `.gitignore` にも入っていないため、コミットされるおそれもあります。本番の CD も VPS の作業ツリー（`~/gotalk`）で `docker compose` を実行するため、そこに置いた override ファイルも同じく読み込まれます。

調査が終わったら、override ファイルを付けずに `docker compose up -d` を実行して `backend` を作り直し、debug log を止めます。override ファイルの `backend` は通常どおり `frontend` の Vite の proxy から届くため、画面からの操作で debug log を確認できます。

## 7. Frontend 開発

Frontend は `frontend` service で Vite dev server として起動します。Compose では `./frontend:/app` と `/app/node_modules` が mount されます。

ホスト上で Frontend コマンドを実行する場合:

```bash
cd frontend
npm install
```

Test:

```bash
npm test
```

Build:

```bash
npm run build
```

その他、`frontend/package.json` には `npm run dev`、`npm run lint`、`npm run test:watch`、`npm run test:coverage`、`npm run preview` が定義されています。

## 8. 注意点

- 録音音声は録音終了のたびに Backend の `/api/interpret` に送信します。Frontend の `SpeechRecognition` / `webkitSpeechRecognition` の認識テキストが得られた場合は `transcript` として同じリクエストに添え、Backend はそのテキストを翻訳します。得られなかった場合は Backend が OpenAI の音声文字起こし API で文字起こしします。
- Backend API は `/health`、`/api/tts`、`/api/interpret`、`/api/translate` の 4 本です。
- TTS は Backend の `/api/tts` から OpenAI Audio Speech API を呼び出し、`audio/mpeg` を返します。
- `http://localhost:5173/#tts-test` を開くと `TtsTestPage` が表示されます。ブラウザの `speechSynthesis`（Web Speech API の音声合成）で日本語とタイ語の発声、`getVoices()` の一覧、発声イベントのログを確認するための開発確認用ページです。Backend の `/api/tts` は使いません。通常の利用画面とは独立しています。
- `http://localhost:5173/#mic-test` を開くと `MicTestPage` が表示されます。通訳の画面で国旗を押すたびにブラウザのマイクのお知らせ（iPhone の Chrome の「マイクへのアクセスが許可されています」など）や許可の画面が出る原因が、`getUserMedia` でマイクを開き直すことか、音声認識（`SpeechRecognition` / `webkitSpeechRecognition`）を始め直すことかを、実機で確かめるための開発確認用ページです。通常の利用画面からはリンクしておらず、通訳の画面の動作は変えません。
  - 使い方：テストのボタンで開始と停止を何回でも繰り返し、ブラウザのお知らせ、許可の画面、マイクの使用中の表示（オレンジの点など）を目で見て記録します。テストを切り替えるときは、前のテストのマイクと音声認識をすべて閉じてから始めます。画面のログ（時刻はミリ秒まで）は「ログをコピー」でクリップボードにコピーでき、コピーできない場合はログの欄を全選択して写せます。
  - テストの内容は次のとおりです。`MediaRecorder` の mimeType は、通訳の画面と同じ選び方です。音声認識の `continuous = true` と `interimResults = true` は通訳の画面と同じですが、`lang` は `ja-JP` に固定しています（通訳の画面は押した国旗の言語）。また、通訳の画面にある、録音の間の音声認識の自動の始め直し（`onend` で `start()` を呼ぶこと）と、`AudioContext`（音量の取得）は、このページのテストにはありません。実機の結果を読むときは、これらの違いに気を付けてください。

    | # | 内容 |
    | --- | --- |
    | S1 | 開始のたびに `getUserMedia({ audio: true })` でマイクを開いて `MediaRecorder` で録音し、停止で録音を止めて track を `stop()` で閉じます（今の通訳の画面のマイクの部分） |
    | S2 | 最初の開始で1回だけマイクを開き、以後は閉じません。開始で `track.enabled = true` にして録音を始め、停止で録音を止めて `track.enabled = false` にします。音声認識は使いません |
    | S3 | 最初の開始で1回だけマイクを開き、以後は閉じません（`track.enabled` は true のまま）。開始のたびに音声認識を新しく作って `start()` し、停止で `stop()` します。録音はしません |
    | S4 | マイク（`getUserMedia`）は開きません。開始のたびに音声認識を新しく作って `start()` し、停止で `stop()` します |
    | S5 | 最初の開始で1回だけマイクを開き、以後は閉じません。開始で `track.enabled = true` にして録音と音声認識を始め、停止で両方を止めて `track.enabled = false` にします |
    | S6 | 「すべて閉じる」で、マイク（すべての track を `stop()`）、録音、音声認識を閉じます。閉じた後に S2 をもう一度始めて、閉じてから開き直したときの動きを確かめます |
    | S7 | 最初の開始で1回だけマイクを開き、以後は閉じません。track は常に `enabled = true` のままで、開始のたびに録音を始め、停止で止めます。音声認識は使いません（S2 と比べて、`enabled` の切り替えの影響を確かめます） |

  - S2、S3、S5、S7 で持っているマイクの track を、ブラウザや OS が終わらせていた（`readyState` が `live` でない）場合は、次の開始で「track が終わっているため開き直す」とログに出し、閉じてから `getUserMedia` で開き直します（ログの `getUserMedia` の開始の行に「開き直し」と付きます）。開き直しでブラウザのお知らせや許可の画面が出る場合があるため、実機の記録と対応を取ってください。
  - 開始の途中で `getUserMedia`、`MediaRecorder`（作成と `start()`）、音声認識（作成と `start()`）のどれかに失敗した場合は、失敗をログに出し、途中まで開いたマイク、録音、音声認識をすべて閉じて、そのテストは始まっていない状態に戻します。
  - `getUserMedia` を待っている間に `pagehide` などで閉じられた場合は、開始の失敗とは区別して「S2 の開始をやめる（開始を待っている間に閉じられたため）」の形でログに出します。このときは「開始に失敗したため、すべて閉じる」は出しません。
  - ログには、テストの操作（開始は何回目か）、`getUserMedia` の開始・成功・失敗（エラーの `name`）、track の `readyState` と `enabled`、track の `ended`（どのテストの何回目の開始の後か）、S1 の停止と S6 で track を `stop()` したこと、`MediaRecorder` の `start`・`stop`・mimeType・録音したデータのバイト数・失敗、音声認識の `onstart`・`onaudiostart`・`onaudioend`・`onend`・`onerror`・`onresult`（結果の文字数だけ）、`navigator.permissions.query({ name: 'microphone' })` の状態（対応していないブラウザでは `unsupported`）、`document.visibilityState` の変化を出します。
  - 録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信も保存もせず、ページの中に表示するだけです（音声認識の結果は文字数だけを表示し、文字列そのものは表示しません）。ただし、音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。
  - ページを離れたとき（`pagehide`）と、ページのコンポーネントが外れたときは、マイク、録音、音声認識をすべて閉じます。

## 関連ドキュメント

- [architecture.md](architecture.md)
- [docker.md](docker.md)
