# GoTalk 本番構成の見直し その3：レート制限と CORS の設計（確定版）

- 状態：ChatGPT の設計レビュー5回目で **承認**（2026年10月11日）
- この文書は、承認された5回目の版に、承認時の非ブロッキングの指摘（C0 の①から⑦）を反映したものです

---

## C0. 5回目のレビュー（承認）の非ブロッキングの指摘への対応

| # | 指摘 | 対応 | 本文の箇所 |
| --- | --- | --- | --- |
| ① | 「OpenAI の 429 を再試行しない」を、OpenAI 的にもすべて再試行不可と誤読されない表現にする | 表現を改めた | 5.7 |
| ② | GoTalk 専用 Project $3 は引き続き妥当 | 変更なし | 8 |
| ③ | `/health` は軽量のまま維持し、OpenAI への接続確認を含めない | 明記した | 5.12 |
| ④ | `quota.json` は、当日の使用量を確かめずに安易に消さない | 運用の注意として明記した | 5.5 |
| ⑤ | `audioBitsPerSecond` はブラウザで対応が違いうる | セキュリティの境界ではないことを再確認（変更なし） | 5.2 |
| ⑥ | FFmpeg がセキュリティの境界の一部になるので、Backend のイメージを長く放置しない | 運用での備えに追加した | 8 |
| ⑦ | 第2段階を忘れず完成させる。PR のマージ → sudo の復旧 → IP の制限を1つの作業の系列として管理する | 明記した | 4 |
| （推奨） | `/api/interpret` の 3層の timeout は `Backend < nginx < Frontend` に余白を付ける（例：Backend 50 から 55 秒、nginx 60 秒、Frontend 65 秒） | 採用。Frontend の `/api/interpret` の timeout を 65 秒にする | 5.11 |

---

## B0. 4回目の指摘への対応（5回目のレビューで、すべて解消と判定済み）

### 承認条件の2点

| # | 前回の承認条件 | 対応 | 本文の箇所 |
| --- | --- | --- | --- |
| 1 | Frontend の timeout は `AbortController` などで実際の `fetch` を abort すると明記し、本番の nginx 経由で Backend の `r.Context()` までキャンセルされることを E2E で確かめる | 明記した。今の Frontend の実装を確認したところ、`/api/interpret`（60 秒）と `/api/translate`（30 秒）は `AbortController` で `fetch` を abort している。`/api/tts` には timeout がなかったので、30 秒の `AbortController` を加える。すべての `fetch` に `signal` を渡すことをテストで確かめる。本番の nginx 経由の E2E の確認を、マージの後の確認の手順に入れる | 5.11、5.13 |
| 2 | 日次の枠のキャンセルのテストを、「永続化の前なら消費しない」「永続化に成功した後なら消費済みのまま（refund しない）」の2つに分ける | 分けた | 5.11 |

### 軽微な指摘と推奨

| 前回の指摘 | 対応 | 本文の箇所 |
| --- | --- | --- |
| TTS の Frontend の timeout を明示し、Backend の deadline（25 秒）より長くする | Frontend の `/api/tts` に 30 秒の timeout を加える | 5.11 |
| OpenAI 用の専用の `http.Client` を作り、`http.DefaultClient` に依存しない | 採用。専用の `http.Client`（`Timeout` 120 秒は安全弁）を作る | 5.11 |
| `context.Canceled`（クライアントの切断）と `context.DeadlineExceeded`（Backend 自身の deadline）を区別し、後者は 504 を返す | 採用。504（`code: "timeout"`）を返し、Frontend は「処理に時間がかかっています。もう一度お試しください」と表示する | 5.7、5.11 |
| `ffmpeg` の `format_whitelist` の名前は、Alpine に入る実際の `ffmpeg` で確かめ、本物の Chrome の WebM/Opus と Safari の MP4/AAC で integration test をする | 採用 | 5.2 |
| WAV の長さは、WAV の data chunk の sample 数で判定する。960,000 samples を超えたら拒否。境界をテストする | 採用 | 5.2 |
| nginx の `client_max_body_size` の既定は 1m で、Backend の 1.5 MiB と合っていない | 第2段階で、nginx の `client_max_body_size` と Backend の `MaxBytesReader` を意図して合わせる。第1段階の間は nginx の 1m が先に効く（安全側）ことを記録する | 6 |
| nginx の request buffering と遅い upload | 第2段階で、`client_max_body_size`、`client_body_timeout`、必要なら `limit_conn` を確かめる | 6 |
| nginx の `proxy_read_timeout`（既定 60 秒）と、Backend の deadline と Frontend の timeout を3層まとめて管理する | 採用。3層の値の表を本文に書き、実測して調整する | 5.11 |
| graceful shutdown の timeout は、Docker Compose の停止の猶予より短くする | 採用。`docker-compose.yml` の `backend` に `stop_grace_period: 30s` を設定し、`Shutdown` の timeout は 25 秒にする | 5.10 |

---

## A0. 3回目の指摘への対応（4回目のレビューで、承認条件はほぼ解消、軽微な指摘はすべて解消と判定済み）

### 承認条件

| 前回の承認条件 | 対応 | 本文の箇所 |
| --- | --- | --- |
| クライアントの切断や Frontend の timeout によるキャンセルを、`ffmpeg` だけでなく、OpenAI へのすべての HTTP リクエストにも伝播させる | `r.Context()` を起点に、エンドポイントごとの処理の deadline を付けた context を作り、`ffmpeg` の `exec.CommandContext`、文字起こし（2回）、Responses API（再試行とフォールバックを含む）、TTS のすべての呼び出しに渡す（`http.NewRequestWithContext`）。キャンセルされたら、残りの OpenAI の呼び出しをせずに処理をやめる | 5.11 |

### 軽微な指摘と推奨

| 前回の指摘 | 対応 | 本文の箇所 |
| --- | --- | --- |
| `ffmpeg` の引数を明確にする。クライアントの MIME で `-f` を決めず、`ffmpeg` の判定と allowlist にする。`-map 0:a:0` で最初の音声の stream を選ぶ | 採用。具体的な引数を本文に書いた | 5.2 |
| 60 秒を超えたら拒否する。検査の余白を `-t 60.25` のように具体値で決める | 採用。`-t 60.25` で decode し、PCM が 60 秒を1サンプルでも超えたら 400 `audio_too_long` | 5.2 |
| transcript は trim の後に有効な文字列かで判定する。空白だけなら transcript なし。500 文字を超えたら音声へのフォールバックではなく 400 | 採用。判定の表を本文に書いた | 5.2 |
| 日次の枠の check → increment → persist を、1つの critical section として `sync.Mutex` で守る | 採用 | 5.5 |
| `quota.json` の「初回（ファイルなし）」は `os.IsNotExist` だけで判定し、permission denied や I/O error を「ファイルなし」と誤認しない | 採用 | 5.5 |
| OpenAI の同時実行の枠は、GoTalk の1リクエスト全体で1枠を最後まで持つ | 採用 | 5.6 |
| `http.Server.Shutdown()` による graceful shutdown | 採用（承認条件ではないが入れる） | 5.10 |

---

## A. 2回目の指摘への対応（3回目のレビューで、すべて解消と判定済み）

### 承認条件の5点

| # | 前回の承認条件 | 対応 | 本文の箇所 |
| --- | --- | --- | --- |
| 1 | 日次の枠は、ファイルへの永続化に成功してから OpenAI を呼ぶ。保存に失敗したら呼ばない（fail closed） | 順序を「枠の確認 → メモリの加算 → ファイルへの atomic な保存に成功 → OpenAI の呼び出し」と明記。保存に失敗したら OpenAI を呼ばず 503。消費した枠は返さない（refund しない）。ファイルが読めない、壊れている場合は「使い切った」とみなす（fail closed） | 5.5 |
| 2 | TTS の重み 6 を見直し、`$0.4 から 0.5/日` を厳密な最大の費用として扱わない | TTS の重みを暫定 20 に上げる。`speed` は 1.0 に固定し、クライアントから `speed` と `instructions` を指定させない（今も指定できない）。対応言語ごとに 500 文字の TTS を実測してから最終の重みを決める。日次の枠は「1単位が概ね $0.001 の保守的なコストの単位」で、実費との一致は保証しない。金額の最終の上限は OpenAI の Project と Organization のハードリミットで保証する、と役割を分けて書き直した | 5.5、7 |
| 3 | 第2段階の IP の状態の TTL 10 分を、1時間以上にする | TTL を 2 時間にする。1時間の制限は token bucket（容量 60、1分に1トークン補充）と明記 | 6 |
| 4 | IP の map が 10,000 件を超えたときの「IP 制限なし」をやめる | 期限切れの状態を先に消し、それでも上限なら、新しい IP は共有の厳しめの overflow bucket に入れる。「上限超過 → IP 制限なし」にはしない | 6 |
| 5 | 60 秒の判定を container の metadata だけに頼らない。できれば Backend で decode と transcode をした音声を OpenAI に渡す | 採用。`ffmpeg` で decode し、最大 60 秒に正規化した音声（WAV、16 kHz、モノラル）を作って、その生成物を OpenAI に渡す。60 秒を超える場合は 400 で拒否する。長さは decode の結果（PCM のサンプル数）から求める。demuxer と codec も許可したものに限る | 5.2 |

### 推奨の項目

| 前回の推奨 | 対応 | 本文の箇所 |
| --- | --- | --- |
| Responses に実際に送る入力全体（固定のプロンプト、固有名詞の置換の後のテキストを含む）の最大のトークン数をテストで確かめる | 採用 | 5.3 |
| transcript がある場合は、音声を Backend に送らない | 採用。Frontend は transcript があるとき音声を送らない。Backend は transcript があれば音声を処理しない（送られても使わず、decode もしない） | 5.2 |
| 同時実行の満杯は 429 ではなく 503 `busy`、`Retry-After: 1` | 採用 | 5.6、5.7 |
| OpenAI の一時的な 429 を 503 に変換するとき、OpenAI の `Retry-After` が妥当ならクライアントにも渡す | 採用（60 秒以下の場合だけ渡す） | 5.7 |
| `TRUST_PROXY_IP_HEADER=true` なのに接続元が信頼済みの proxy でない場合は、警告のログを出してリクエストを拒否する | 採用 | 6 |
| GoTalk 専用の OpenAI Project を作り、専用の API キーとハードリミット $3 にする | 採用（運用の手順） | 8 |
| `Retry-After` の計算の方法を決める | 短時間の制限は固定の秒数、日次の枠は次の日本時間の0時までと明記 | 5.7 |
| 日本時間は、コンテナの timezone に依存せず明示する | `time.FixedZone("JST", 9*60*60)` を使い、tzdata に依存しない | 5.5 |
| `ffmpeg` の同時実行も 4 程度に制限する | 採用 | 5.6 |
| `http.Server` の timeout と `MaxHeaderBytes` を設定する | 採用 | 5.10 |
| JSON の decoder で unknown fields を拒否し、後ろに2つ目の値がないことを確かめる | 採用 | 5.1 |

---

## 1. 背景と方針

- GoTalk は、ブラウザで話した言葉を OpenAI の API（Whisper、gpt-4o-mini、TTS）で通訳する個人開発の Web アプリです
- 本番は `https://gotalk.chiemaru.com`（さくらの VPS 1台、Docker Compose、nginx が HTTPS を終端）です
- 誰でもログインなしで試せる状態を保ちたい、というのがオーナーの方針です。悪用への対策は「レート制限だけ」と決めています（ログインや CAPTCHA は入れない）。入力の大きさや長さの上限は、「1回あたりの費用」を制限するもので、レート制限と一体の対策として扱います
- 守りたいのは、第三者の大量のリクエストによる OpenAI の利用料の増加と、正規の利用者が使えなくなる事態です

## 2. 現状（確認済みの事実）

### API と OpenAI の呼び出し

| エンドポイント | 中身 | OpenAI の呼び出し |
| --- | --- | --- |
| `POST /api/interpret` | multipart で受け取る。Frontend は今、音声（`audio`）と、ブラウザの音声認識の結果（`transcript`）があればその両方を送っている。transcript があれば Whisper を使わない | transcript なしなら文字起こし2回（言語判定と文字起こし）。その後、翻訳の処理（下の `/api/translate` と同じ） |
| `POST /api/translate` | JSON でテキストを受け取って翻訳 | 固有名詞の保護の経路では、翻訳と逆翻訳に、それぞれ1回まで再試行がある。保護に失敗すると、保護しない経路（言語判定を含む翻訳と逆翻訳）にフォールバックする。最大で6回程度（実装で確定させる） |
| `POST /api/tts` | JSON でテキストを受け取って読み上げ音声を返す。リクエストは `{"text": "..."}` だけで、model と voice は Backend の環境変数で決まる。`speed` と `instructions` は送っていない | TTS 1回 |
| `GET /health` | 死活監視 | なし |

- 入力の大きさの制限：`/api/interpret` は `ParseMultipartForm(32 << 20)` だけで、body 全体の上限はありません。`/api/translate` と `/api/tts` は、テキストの長さにも body にも上限がありません
- Responses API の呼び出しに `max_output_tokens` は設定していません
- Frontend の録音に長さの上限はなく、ビットレートも指定していません。Frontend が送る音声は webm（Chrome など）か mp4（Safari）です
- Go の `http.Server` は `http.ListenAndServe` で起動しており、timeout は設定していません
- 認証はありません

### CORS

- Backend は、すべての応答に `Access-Control-Allow-Origin: *` などを付け、`OPTIONS` に 204 を返しています
- Frontend は `fetch('/api/...')` で同じオリジンに送っています。本番は nginx が `/api/` を Backend に転送し、開発環境は Vite の proxy（`/api` を Backend に転送）を使っています。どちらもブラウザから見て同じオリジンです

### ネットワーク

- Backend（8080）と Frontend の Vite の開発サーバー（5173）の Docker のポートは、`127.0.0.1` だけに公開しています（外から直接届かないことは確認済み）。Docker Engine は 29.6.0 です
- nginx の `location /api/` は `proxy_pass http://127.0.0.1:8080/api/;` と `proxy_set_header Host $host;` だけで、`X-Real-IP` も `X-Forwarded-For` も設定していません。そのため、今は Backend から利用者の IP アドレスが分かりません

### OpenAI の利用の実績と上限（2026年9月10日から10月10日の30日間）

| 種類 | 回数 | 量 |
| --- | --- | --- |
| Responses（翻訳、言語判定、逆翻訳） | 239 回（1日の最大 71 回） | 入力 33,219 トークン |
| Audio Transcriptions | 63 回 | 511 秒 |
| Audio Speeches（TTS） | 0 回 | 0 文字 |
| 合計の金額 | | $0.09（1日の最大は約 $0.04） |

- 開発とテストの分が多く含まれます
- OpenAI の組織の支出上限は、月 $10 のハードリミット（「Limit enforced」）に設定済みです。通知は $8 と $10 です
- API は前払いのクレジットで、自動の補充は無効です。ただし残高は設計上の安全装置としては数えません
- OpenAI の Project は「Default project」だけを使っています

### 運用上の制約

- VPS の sudo のパスワードが現在使えません（復旧は別の作業として予定）。そのため、今すぐには nginx の設定を変えられません
- Backend は Docker Compose の `backend` サービス1つ（1プロセス）です。デプロイ（GitHub Actions の CD）のたびにコンテナが作り直されます
- Backend のイメージは `alpine:3.22` です

## 3. 要件

1. 1人（1つの IP）が短時間に大量のリクエストを送っても、OpenAI の利用料が際限なく増えないこと
2. 多数の IP から分散して送られても、1日の利用料に上限があること（デプロイでコンテナを作り直しても、上限が保たれること）
3. 1回のリクエストあたりの費用に上限があること
4. 普通の利用（会話の中で数秒から数十秒に1回の通訳）は妨げないこと
5. 制限に掛かったとき、利用者に分かる形で知らせること
6. ログインなしで誰でも試せる状態は保つこと

## 4. 進め方（2段階）

- **第1段階（この PR。sudo なしで入れる）**：費用の防御。1回あたりの費用の上限、全体の流量、日次の枠、同時実行数、OpenAI の支出上限のエラーの扱い、CORS の整理、HTTP サーバーの timeout
- **第2段階（sudo の復旧の後）**：可用性の防御。IP ごとの制限を有効にする
- 「第1段階の PR のマージ → sudo の復旧 → 第2段階（IP の制限）」を、1つの作業の系列として管理する
- 第1段階だけでは、1人が日次の枠を使い切ると、その日は正規の利用者も使えなくなります。第1段階は費用の防御であり、可用性の防御ではありません。**第2段階までを、この設計の完成条件とします**
- 分散した IP からの攻撃は、認証や CAPTCHA を使わない以上、完全には防げません。その場合は、全体の日次の枠でサービスを止めて費用を守る、という残存リスクとして受け入れます
- 防御の層：入力の大きさ → 音声の長さ（decode して正規化）→ 全体の流量 → 同時実行数 → OpenAI の呼び出しごとの日次の枠（永続化）→ OpenAI の Project のハードリミット → Organization のハードリミット

## 5. 第1段階の設計

### 処理の順序

1. `/health` 以外の OpenAI を呼ぶ3つのエンドポイントで、最初に全体の短時間の制限（5.6 の token bucket）を確かめる
2. body の上限（5.1）を適用してから、入力を解析して検証する（5.1）
3. 音声がある場合は、メディアの処理の同時実行の枠（5.6）を取って、decode と正規化（5.2）をする
4. OpenAI の呼び出しの同時実行の枠（5.6）を取る
5. OpenAI を呼ぶ直前ごとに、日次の枠を消費して永続化する（5.5）。永続化に成功してから呼ぶ
- 入力の検証や音声の処理に失敗したリクエストでは、日次の枠を消費しません（不正なリクエストだけで日次の枠を使い切られないため）

### 5.1 body と入力の大きさの上限

| 対象 | 上限 | 方法 |
| --- | --- | --- |
| `/api/interpret` の body 全体 | 1.5 MiB | 解析の前に `http.MaxBytesReader` |
| `/api/interpret` の音声ファイル | 1 MiB | multipart の音声の part の大きさを確かめる |
| `/api/interpret` の transcript | 500 文字（rune） | 解析の後に確かめる |
| `/api/translate`、`/api/tts` の body 全体 | 16 KiB | 解析の前に `http.MaxBytesReader` |
| `/api/translate`、`/api/tts` のテキスト | 500 文字（rune） | 解析の後に確かめる |

- 超えた場合は 413（body）か 400（テキストの長さ）で拒否し、OpenAI は呼びません
- `ParseMultipartForm` の引数（メモリに置く上限）も、body の上限に合わせて小さくします
- JSON は `json.Decoder` で `DisallowUnknownFields` を使い、1つ目の値の後ろに別の値がないこと（`Decode` の2回目が `io.EOF` であること）を確かめます。Frontend が送るフィールドと構造体が一致していることを、テストで確かめます

### 5.2 音声の扱い（decode して最大 60 秒に正規化）

- **transcript と音声の判定**：transcript は、前後の空白を除いた後に空でない場合だけ「有効」とする

| transcript | 音声 | 扱い |
| --- | --- | --- |
| 有効（500 文字以下） | あってもなくてもよい | transcript の経路。音声は使わず、decode もしない。文字起こしは呼ばない |
| 500 文字を超える | 問わない | 400 `input_too_large`（音声へはフォールバックしない） |
| ない、または空白だけ | あり | 音声の経路（下の手順） |
| ない、または空白だけ | なし | 400 |

- Frontend は、有効な transcript があるときは音声を送らない
- **音声の経路**：Backend は次の手順で処理する
  1. 音声を一時ファイルに書く
  2. `ffmpeg` を shell を通さず、固定の引数で `exec.CommandContext` から実行する。context はリクエストの context（5.11）から作り、さらに 10 秒の timeout を付ける
     - クライアントが送る MIME やファイル名の拡張子で `-f` を決めず、`ffmpeg` 自身の判定と allowlist で絞る
     - 引数の方針（具体的な値は実装で確定し、テストで確かめる）：

```text
ffmpeg -nostdin -hide_banner -loglevel error
  -protocol_whitelist file
  -format_whitelist matroska,webm,mov,mp4,m4a
  -codec_whitelist opus,aac
  -i <入力の一時ファイル>
  -map 0:a:0 -vn -sn -dn
  -ac 1 -ar 16000 -c:a pcm_s16le
  -t 60.25
  -f wav <出力の一時ファイル>
```

     - `-map 0:a:0` で最初の音声の stream だけを選ぶ。音声の stream がない、許可していない demuxer や codec の場合は、`ffmpeg` が失敗するので 400 `invalid_audio`
     - `-format_whitelist` に書く名前は、Backend のイメージに実際に入る `ffmpeg` で `ffmpeg -demuxers` を実行して確かめる（例えば Matroska と WebM の demuxer の名前は `matroska,webm` のように、拡張子や一般の名前とは限らない）
     - 本物の Chrome で録音した WebM/Opus と、Safari で録音した MP4/AAC のサンプルで、integration test をする（テストの音声には発話の内容を含めない。無音や合成音などを使う）
  3. 出力の WAV の data chunk の sample 数（ファイル全体のバイト数ではない）から長さを計算する。16,000 samples/秒、モノラル、16 bit なので、60 秒は 960,000 samples。960,000 samples を1つでも超えていたら、OpenAI を呼ばずに 400 `audio_too_long` で拒否する（60 秒で切り詰めて受け付けることはしない。container の metadata の duration には頼らない）
     - 境界のテスト：59.999 秒、60.000 秒、60 秒 + 1 sample、60.25 秒以上
  4. OpenAI（言語判定と文字起こしの2回）には、この正規化した WAV を渡す
  5. 一時ファイルは、成功しても失敗しても必ず消す
- Backend のイメージ（`alpine:3.22`）に `ffmpeg` のパッケージを加える
- **Frontend**：録音を 60 秒で自動的に止め、残り時間を表示する。`MediaRecorder` に `audioBitsPerSecond` を指定する。これは使い勝手のためで、セキュリティの境界にはしない
- 悪意のある音声を native のパーサーに渡す危険はゼロではないが、1 MiB の上限、10 秒の timeout、demuxer と codec の制限、Docker のコンテナ、shell を通さない実行、全体の流量と同時実行の制限で、個人のアプリとして受け入れられる範囲と判断する

### 5.3 OpenAI の出力と入力の上限

- Responses API のすべての呼び出し（翻訳、言語判定を含む翻訳、逆翻訳、再試行）に `max_output_tokens: 1024` を設定する
- 出力が上限で打ち切られた場合（`status` が `incomplete` など）は、翻訳の失敗として扱う
- OpenAI に実際に送る入力全体（固定のプロンプト、固有名詞の置換の後のテキスト、再試行のプロンプトを含む）が、入力 500 文字のときに最大で何トークンになるかを、テストで確かめる（トークン数の概算か、OpenAI の usage の値で確かめる）

### 5.4 1リクエストあたりの OpenAI の呼び出しの最大回数

- 実装の中の再試行とフォールバックをすべて洗い出し、1リクエストあたりの OpenAI の呼び出しの最大回数を、コードの定数とテストで固定する
  - 今の見込み：`/api/translate` は最大6回程度、`/api/interpret`（transcript なし）は文字起こし2回＋翻訳の処理、`/api/tts` は1回
- 再試行の回数は、今の「翻訳と逆翻訳でそれぞれ1回まで」を上限として明示する

### 5.5 日次の枠（永続化、重み付き、fail closed）

- **役割**：日次の枠は、1単位が概ね $0.001 になるように重みを置いた、**保守的なコストの単位**です。実費との一致は保証しません。**金額の最終の上限は、OpenAI の Project と Organization のハードリミットで保証します**（8）
- OpenAI を呼ぶ直前ごとに、次の重みで消費します

| 呼び出し | 重み | 根拠 |
| --- | --- | --- |
| Responses（翻訳など。`max_output_tokens: 1024`、入力 500 文字） | 1 | gpt-4o-mini は入力 $0.15/1M、出力 $0.60/1M。1回あたり約 $0.001 以下 |
| 文字起こし（正規化した 60 秒以下の音声） | 6 | 約 $0.006/分 |
| TTS（500 文字まで、`speed` 1.0 固定） | **20（暫定）** | gpt-4o-mini-tts は音声の出力が中心の課金で、言語によって 500 文字の音声の長さが変わる。対応言語（日本語、英語、中国語の簡体と繁体、韓国語、タイ語、ベトナム語）ごとに 500 文字の TTS を実測し、余裕を持たせて最終の重みを決める（実測は実装の段階で行い、結果を PR に記録する） |

- 日次の枠の既定値：**1日 400**（重みの合計）
  - 普段の利用の目安：音声の通訳（文字起こし2回＋翻訳の処理2回）は 1回で約 14、transcript ありの通訳や翻訳は約 2 から 4、TTS は 20
  - 実績の最大の日を重みに換算すると、約 220 です（TTS は実績で 0 回）
- **消費の順序**：枠の残りを確かめる → メモリの使用量に加算する → ファイルへの atomic な保存に成功する → OpenAI を呼ぶ
  - 保存に失敗した場合は、OpenAI を呼ばず、503（`code: "service_unavailable"`）を返す。ログに `quota_state_error` を出す
  - 消費した枠は、OpenAI の呼び出しが失敗しても返さない（refund しない）。呼び出しが OpenAI に届いたかどうかが分からない場合があるため、予約の時点で消費したものとする
- 枠を使い切ったら、429（`code: "daily_limit_reached"`）を返す。`Retry-After` は次の日本時間の0時までの秒数
- **永続化**：名前付き Docker volume（例：`gotalk-quota`）を `backend` にマウントし、`/data/quota.json` に `{"date": "2026-10-11", "used": 123}` を保存する
  - 書き込みは、同じディレクトリの一時ファイルに書いてから `rename` する（壊れたファイルを残さないため）。`fsync` はしない（個人のアプリで、ハードリミットが最後の歯止めのため）
  - 1プロセスなので、`sync.Mutex` で守る。「枠の残りの確認 → メモリの加算 → ファイルへの保存」を1つの critical section にし、2つのリクエストが同じ残りを見て、両方が加算する競合を起こさない
  - 日付は `time.FixedZone("JST", 9*60*60)` で計算する（コンテナの timezone と tzdata に依存しない）
- **起動時**：ファイルを読み、日付が今日（日本時間）なら続きから、違えば 0 から始める。ファイルがない場合（初回）は 0 から始める。「ファイルがない」の判定は `os.IsNotExist`（`errors.Is(err, fs.ErrNotExist)`）だけで行い、permission denied や I/O error などは「ファイルがない」とみなさない（下の fail closed に入れる）
  - ファイルが読めない、壊れている場合は、**「使い切った」とみなす（fail closed）**。ログに `quota_state_error` を出し、OpenAI を呼ぶリクエストには 503（`code: "service_unavailable"`）を返す。復旧は、オーナーがファイルを直すか消して、コンテナを再起動する。ファイルを消すと、その日の枠が 0 から再開する（その日の枠のリセットになる）ため、当日の使用量を確かめずに安易に消さない
- 日次の枠の使用量と残りは、ログに出す（5.8）

### 5.6 全体の短時間の制限と同時実行数

- **全体の token bucket**：OpenAI を呼ぶ3つのエンドポイントに、Backend 全体で1つ。毎分 20、バースト 10（`golang.org/x/time/rate` の `Allow`）。超えたら 429（`code: "rate_limited"`）
- **メディアの処理の同時実行数**：`ffmpeg` の実行を同時に 4 までにする（semaphore）
- **OpenAI の呼び出しの同時実行数**：OpenAI を呼ぶ処理を同時に 4 までにする（semaphore）。枠は GoTalk の1リクエスト全体で1つを取り、そのリクエストの OpenAI の呼び出し（再試行とフォールバックを含む）が終わるまで持つ。最大で4つの会話だけが同時に進む
- どちらも、空きがない場合は待たずに 503（`code: "busy"`、`Retry-After: 1`）を返す

### 5.7 応答の形と Frontend の表示

| 状況 | status | body の `code` | `Retry-After` | Frontend の表示（案） |
| --- | --- | --- | --- | --- |
| GoTalk の全体の短時間の制限 | 429 | `rate_limited` | 固定の秒数（例：5） | 混み合っています。しばらくしてからお試しください |
| GoTalk の同時実行数の満杯（メディアの処理、OpenAI の呼び出し） | 503 | `busy` | 1 | 混み合っています。しばらくしてからお試しください |
| GoTalk の日次の枠 | 429 | `daily_limit_reached` | 次の日本時間の0時まで | 本日の利用上限に達しました。明日またお試しください |
| GoTalk の日次の枠のファイルの異常（fail closed） | 503 | `service_unavailable` | なし | 現在サービスを利用できません |
| GoTalk の IP ごとの制限（第2段階） | 429 | `rate_limited` | 固定の秒数 | 混み合っています。しばらくしてからお試しください |
| 入力が大きすぎる、長すぎる、音声が 60 秒を超える、音声の形式が不正 | 413 / 400 | `input_too_large`、`audio_too_long`、`invalid_audio` など | なし | 録音が長すぎます、などの個別の表示 |
| OpenAI の支出上限、クレジットの枯渇（`organization_spend_limit_exceeded`、`project_spend_limit_exceeded`、`insufficient_quota` など） | 503 | `service_unavailable` | なし | 現在サービスを利用できません |
| OpenAI の一時的な rate limit | 503 | `upstream_busy` | OpenAI の `Retry-After` が 60 秒以下なら、その値 | 混み合っています。しばらくしてからお試しください |
| Backend 自身の処理の deadline に達した（`context.DeadlineExceeded`） | 504 | `timeout` | なし | 処理に時間がかかっています。もう一度お試しください |
| OpenAI の障害など | 502 | 既存の扱い | なし | 既存の表示 |

- body は `{"error": "<人が読む文>", "code": "<機械が読む値>"}` の形にする
- 利用者には、`$10` などの金額や、OpenAI の内部のエラーコードは見せない
- GoTalk の Backend の中では、OpenAI の 429 を自動で再試行しない。支出の上限やクレジットの枯渇は、再試行しても回復しない。一時的な rate limit（`Retry-After` の後なら再試行できるもの）は 503 `upstream_busy` に変換し、必要なら利用者の操作で Frontend から再実行する
- 短時間の制限の `Retry-After` は、`x/time/rate` の `Allow` が待ち時間を返さないため、固定の秒数にする

### 5.8 ログ

- 制限に掛かったときに、`endpoint`、`limit_type`（`global_rate`、`busy`、`daily`、`quota_state_error`、`ip_rate`、`ip_hourly`、`ip_overflow`、`untrusted_proxy`、`input_size`、`audio_duration`、`invalid_audio`）、status、日次の枠の使用量と残りを出す
- IP アドレス、発話の内容、音声の内容は出さない（前回の作業で決めた方針）

### 5.9 CORS

- `Access-Control-Allow-*` のヘッダを付けるのをやめる。本番も開発環境も、ブラウザから見て同じオリジンなので不要
- `OPTIONS` は、Go の `net/http` の既定の動作（ハンドラ側で 405）に任せる
- CORS は悪用の対策ではない。対策はレート制限と入力の上限で行う

### 5.10 HTTP サーバーの設定

- `http.ListenAndServe` をやめて `http.Server` を使い、次を設定する（値は実装の段階で、処理の最長の時間に合わせて確定させる）
  - `ReadHeaderTimeout`：10 秒
  - `ReadTimeout`：30 秒（1.5 MiB の body を遅い回線で送る場合を考える）
  - `WriteTimeout`：処理の最長（音声の decode、文字起こし2回、翻訳の処理）より長くする。Frontend の `/api/interpret` の timeout は 60 秒なので、例えば 90 秒
  - `IdleTimeout`：60 秒
  - `MaxHeaderBytes`：16 KiB
- `SIGTERM` を受けたら `http.Server.Shutdown()` で graceful shutdown する。待つ時間は 25 秒で、超えたら `Close` する。`docker-compose.yml` の `backend` に `stop_grace_period: 30s` を設定し、Docker Compose の停止の猶予（既定は 10 秒）より `Shutdown` の待ち時間が短くなるようにする

### 5.11 キャンセルの伝播と処理の deadline

- 各エンドポイントは、`r.Context()` を起点に、エンドポイントごとの処理の deadline を付けた context を作る
- この context を、次のすべてに渡す
  - `ffmpeg` の `exec.CommandContext`（さらに 10 秒の timeout を付ける）
  - 文字起こし（言語判定と文字起こしの2回）
  - Responses API の呼び出し（翻訳、逆翻訳、再試行、フォールバック）
  - TTS
- OpenAI への HTTP リクエストは `http.NewRequestWithContext` で作り、OpenAI 用の専用の `http.Client` で送る（`http.DefaultClient` は使わない）。専用の client の `Timeout` は 120 秒で、context の deadline より長い安全弁とする
- 各 OpenAI の呼び出しの前と、日次の枠を消費する前に、context が終わっていないかを確かめる。終わっていたら、日次の枠を消費せず、残りの OpenAI の呼び出しをせずに処理をやめる
  - ただし、確かめた後、日次の枠を永続化した後にキャンセルされることはありうる。その場合、消費した枠は返さない（5.5 の refund しない方針を維持する）
- context の終わり方で、応答を分ける
  - `context.Canceled`（クライアントの切断、Frontend の abort）：クライアントはもういないので、応答は書かないか、書き込みに失敗してもよい。ログに `canceled` を出す
  - `context.DeadlineExceeded`（Backend 自身の deadline）：クライアントはまだいる可能性があるので、504（`code: "timeout"`）を返す。ログに `timeout` を出す
- **Frontend**：すべての `fetch` に `AbortController` の `signal` を渡し、timeout で実際の `fetch` を abort する（画面の上だけで timeout 扱いにはしない）
  - 今の実装：`/api/interpret`（60 秒）と `/api/translate`（30 秒）は、`AbortController` で `fetch` を abort している（確認済み）
  - `/api/tts` には timeout がないので、30 秒の `AbortController` を加える
  - 入力中に送る翻訳の `fetch`（debounce したもの）も、画面の状態が変わったときに abort されることを確かめる
- **3層の timeout**（実測して調整する）

| 層 | `/api/interpret` | `/api/translate` | `/api/tts` |
| --- | --- | --- | --- |
| Backend の処理の deadline | 55 秒 | 25 秒 | 25 秒 |
| nginx の `proxy_read_timeout`（今は既定の 60 秒） | 60 秒 | 60 秒 | 60 秒 |
| Frontend の timeout | 65 秒（今の 60 秒から変更） | 30 秒 | 30 秒（追加） |

  - `/api/interpret` は `Backend < nginx < Frontend` になるよう、Frontend を 65 秒にする。Backend の 55 秒は実測して 50 から 55 秒の範囲で調整する。Backend の deadline を 60 秒より長くする場合は、nginx の `proxy_read_timeout` も合わせて変える必要がある（sudo が要る）
- **テスト**
  - `ffmpeg` の実行中に context をキャンセルすると、`ffmpeg` が止まること
  - 日次の枠の永続化の**前**にキャンセルした場合：それ以降の OpenAI の呼び出し（mock）がされず、日次の枠は消費されないこと
  - 日次の枠の永続化に成功した**後**にキャンセルした場合：OpenAI の呼び出し（mock）はされず、日次の枠は消費済みのまま（refund されない）こと
  - Backend の deadline に達した場合：504（`code: "timeout"`）が返ること
  - Frontend：すべての `fetch` に `signal` が渡され、timeout で abort されること
- **本番の E2E の確認（マージの後）**：本番の画面（nginx 経由）で処理中に abort し、Backend のログに `canceled` が出て、それ以降の OpenAI の呼び出しがされないことを確かめる（nginx は既定の `proxy_ignore_client_abort off` で、クライアントが切断すると upstream の接続も閉じる。5.13）

### 5.12 設定

- 上の数値は、すべて環境変数で変えられるようにし、`docker-compose.yml` に既定値を書く
- `/health` は制限の対象外。`/health` は軽量のまま維持し、将来も OpenAI への接続確認などの外部の呼び出しを含めない（監視のたびに外部の API を呼ぶことになるため）

### 5.13 マージの後の確認

- 本番の画面で、通訳、翻訳、読み上げが動くこと
- 本番の画面（nginx 経由）で処理中に abort し、Backend のログに `canceled` が出て、それ以降の OpenAI の呼び出しがされないこと（5.11）
- 日次の枠のファイル（`/data/quota.json`）が volume に作られ、デプロイの後も使用量が引き継がれること
- 制限に掛かったときの表示（429、503）

## 6. 第2段階の設計（sudo の復旧の後。この設計の完成条件）

1. nginx の `location /api/` に `proxy_set_header X-Real-IP $remote_addr;` を加える（クライアントが送った `X-Real-IP` は nginx が上書きする）
2. Backend は、`TRUST_PROXY_IP_HEADER=true` **かつ** `r.RemoteAddr` が `TRUSTED_PROXY_CIDRS` に含まれる場合だけ、`X-Real-IP` を信じる
   - `TRUST_PROXY_IP_HEADER=true` なのに、接続元が信頼済みの proxy でない場合、または `X-Real-IP` がない、解析できない場合は、警告のログ（`untrusted_proxy`）を出して、そのリクエストを拒否する（403、`code: "forbidden"`）。本番では nginx を経由しない Backend へのアクセスはないはずのため、静かに IP の制限を無効にはしない
   - `TRUSTED_PROXY_CIDRS` は、第2段階の導入時に、実際の環境で Backend から見える `r.RemoteAddr`（Docker の NAT の構成で、`127.0.0.1` ではなく bridge 側のアドレスになりうる）を確かめてから設定する
3. IP は `net/netip` で解析して正規化する（IPv4-mapped IPv6 は IPv4 に）。IPv6 は /64 単位でキーにする
4. IP ごとの制限は、2つの token bucket で行う
   - 毎分：容量 10、毎分 10 トークン補充
   - 1時間：容量 60、1分に1トークン補充
5. IP ごとの状態は、使われなくなってから **2 時間**で消す（1時間の制限より長くし、状態が消えて枠が戻る抜け道を作らない）
6. IP の状態のキーの数に上限（10,000）を持たせる。上限に達したら、まず期限切れの状態を消す。それでも空きがなければ、新しい IP は**共有の overflow bucket**（すべての溢れた IP で1つ。毎分 10、容量 10）に入れる。「上限超過 → IP 制限なし」にはしない
7. nginx の `client_max_body_size`（既定 1m）と、Backend の `MaxBytesReader`（`/api/interpret` は 1.5 MiB）を意図して合わせる。第1段階の間は、nginx の 1m が先に効く（安全側だが、仕様と実環境が一致しない）ことを記録しておく
8. nginx の `client_body_timeout` と、必要なら `limit_conn` を確かめる（遅い upload による nginx 側の負荷への備え）
9. 必要なら、nginx の `limit_req` を外側の守りとして加える（任意）

## 7. 費用の考え方

- 日次の枠は、1単位が概ね $0.001 の保守的なコストの単位として置いた**予算の近似**で、実費との一致は保証しません
- 単価の前提（OpenAI の公開されている価格）：gpt-4o-mini は入力 $0.15/1M、出力 $0.60/1M、文字起こしは約 $0.006/分。TTS は gpt-4o-mini-tts のテキストの入力 $0.60/1M と音声の出力 $12/1M（音声のトークン）で、言語ごとの実測で重みを確かめる
- 金額の最終の上限は、OpenAI の Project のハードリミット（$3、これから設定）と Organization のハードリミット（$10、設定済み）で保証します

## 8. 運用での備え（コードの外）

- **設定済み**：OpenAI の組織の月のハードリミット $10（通知 $8、$10）
- **これから設定する**：GoTalk 専用の OpenAI Project（例：「GoTalk」）を作り、GoTalk 専用の API キーを発行し、その Project に月のハードリミット $3 を設定する。VPS の `~/gotalk/.env` の `OPENAI_API_KEY` を新しいキーに差し替える（sudo は不要）。古いキー（Default project）の扱いは、ほかで使っていないことを確かめてから決める
- FFmpeg はセキュリティの境界の一部になるので、Backend のイメージを長く放置しない。Alpine のパッケージの更新に合わせて、定期的にイメージを build し直す
- 前払いのクレジットの残高と、自動の補充が無効であることは、今の時点の状態にすぎないため、設計上の安全装置としては数えない。自動の補充は無効のままにする方針

## 9. この PR の範囲外として記録すること

- 前回のレビューで、OpenAI が `gpt-4o-mini-tts` 系を 2027年1月6日に、`whisper-1`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe` を 2027年2月26日に停止する予定と教えていただきました。GoTalk の別の issue として、移行を扱います（停止の予定は、issue を作る時点で OpenAI のドキュメントで確かめます）
