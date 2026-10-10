# Backend API

## 1. 概要

GoTalk Backend API は、Frontend から送られる録音音声または認識済みテキストを受け取り、文字起こし、翻訳、バックトランスレーション、読み上げ音声生成を実行する API です。

Backend は OpenAI API キーをサーバー側だけで扱います。Frontend は OpenAI API を直接呼び出さず、Backend の `/api/interpret`、`/api/translate`、`/api/tts` を呼び出します。

Backend の主な役割は次のとおりです。

- Frontend から録音音声を受け取り、確定翻訳を返す（`/api/interpret`）
- Frontend からテキストを受け取り、翻訳を返す（`/api/translate`）
- OpenAI の音声文字起こし API を使って言語判定と文字起こしを行う
- OpenAI Responses API を使って翻訳とバックトランスレーションを行う
- 必要な場合に固有名詞保護を適用する
- OpenAI Audio Speech API を使って TTS を行う
- OpenAI API キーを Backend 側だけで扱う

## 2. API 一覧

| Method | Path | 概要 |
| --- | --- | --- |
| `GET` | `/health` | ヘルスチェック |
| `POST` | `/api/tts` | TTS |
| `POST` | `/api/interpret` | 録音音声の確定翻訳（認識テキストの翻訳、または文字起こしと翻訳）・バックトランスレーション |
| `POST` | `/api/translate` | テキストの翻訳・バックトランスレーション |

## 3. 共通仕様

Backend は Go の `net/http` で実装されています。`main()` では次の route を登録します。

- `/health`
- `/api/tts`
- `/api/interpret`
- `/api/translate`

CORS middleware は全 API に適用されます。

| Header | 値 |
| --- | --- |
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type` |

`OPTIONS` request は handler に渡さず、HTTP 204 を返します。

`/api/translate` と `/api/tts` は JSON request body を受け取ります。Frontend はどちらも `Content-Type: application/json` を付けて送信します。`/api/interpret` は `multipart/form-data` を受け取ります。

JSON error response は次の形式です。

```json
{
  "error": "error message"
}
```

`writeError` を使うエラーでは `Content-Type: application/json` が設定されます。`/api/tts`、`/api/interpret`、`/api/translate` の許可されない HTTP method は `http.Error` で処理され、HTTP 405 と本文 `method not allowed` を返します。

OpenAI API キーは `OPENAI_API_KEY` から読みます。未設定時の扱いは API ごとに異なります。

| API | HTTP status | Response |
| --- | --- | --- |
| `/api/tts` | 500 | `{"error":"service unavailable"}` |
| `/api/interpret` | 500 | `{"error":"service unavailable"}` |
| `/api/translate` | 500 | `{"error":"translation service unavailable"}` |

`/health` は OpenAI API キーを参照しません。

## 4. GET /health

| 項目 | 内容 |
| --- | --- |
| Method | `GET` |
| Path | `/health` |
| 目的 | Backend のヘルスチェック |
| Response Content-Type | `application/json` |

Response:

```json
{
  "status": "ok"
}
```

実装上、`healthHandler` は HTTP method を判定していません。CORS middleware が `OPTIONS` を 204 で処理し、それ以外の method では同じ JSON response を返します。

## 5. POST /api/interpret

| 項目 | 内容 |
| --- | --- |
| Method | `POST` |
| Path | `/api/interpret` |
| 目的 | 録音音声と話者情報を受け取り、認識テキストまたは文字起こし結果を翻訳して、バックトランスレーションと TTS 用テキストを返す |
| Request Content-Type | `multipart/form-data` |
| Response Content-Type | `application/json` |

Backend は `r.ParseMultipartForm(32 << 20)` で request を parse します。

Request form fields:

| Field | Type | 必須 | 内容 |
| --- | --- | --- | --- |
| `audio` | file | yes | 録音音声。Frontend はファイル名を `recording.webm`、`recording.mp4`、`recording.ogg` のいずれかにして送る |
| `myLanguage` | string | yes | 話者側の言語。`{"id","label"}` 形式の JSON 文字列。`id` が空の場合はエラー |
| `theirLanguage` | string | yes | 相手側の言語。`{"id","label"}` 形式の JSON 文字列。`id` が空の場合はエラー |
| `speaker` | string | 条件付き | 話者の言語 ID。`transcript` がある場合は `myLanguage.id` または `theirLanguage.id` に一致する必要がある |
| `transcript` | string | no | Frontend の `SpeechRecognition` で得た認識テキスト。前後の空白は除去して扱う |

Request 例（`curl`）:

```bash
curl -s http://localhost:8080/api/interpret \
  -F "audio=@recording.webm" \
  -F 'myLanguage={"id":"ja","label":"Japanese"}' \
  -F 'theirLanguage={"id":"en","label":"English"}' \
  -F "speaker=ja" \
  -F "transcript=こんにちは"
```

Response body:

| Field | Type | 内容 |
| --- | --- | --- |
| `text` | string | 翻訳対象にした原文。`transcript` がある場合はその値、ない場合は文字起こし結果 |
| `sourceLanguage` | string | 翻訳元言語 ID |
| `targetLanguage` | string | 翻訳先言語 ID |
| `translatedText` | string | 表示用の翻訳結果 |
| `backTranslation` | string | 翻訳結果を翻訳元言語へ戻した文字列 |
| `ttsText` | string | `/api/tts` に渡す読み上げ用テキスト |

Response 例:

```json
{
  "text": "こんにちは",
  "sourceLanguage": "ja",
  "targetLanguage": "en",
  "translatedText": "Hello",
  "backTranslation": "こんにちは",
  "ttsText": "Hello"
}
```

`/api/translate` の response と比べると、`text` が 1 つ多い構成です。

### 処理経路

`/api/interpret` は `transcript` の有無で処理経路を分けます。

| 経路 | 条件 | 翻訳元の決定 | 原文 |
| --- | --- | --- | --- |
| transcript 経路 | `transcript` が空でない | `speaker` が `myLanguage.id` に一致すれば `myLanguage` を翻訳元、`theirLanguage.id` に一致すれば `theirLanguage` を翻訳元にする。どちらにも一致しなければ HTTP 400 `invalid speaker` | `transcript` |
| Whisper 経路 | `transcript` がない、または空白のみ | `whisper-1` で判定した言語を `myLanguage`、`theirLanguage` の順に照合する。どちらにも一致しなければ HTTP 422 `language_mismatch` | `WHISPER_MODEL` による文字起こし結果 |

Whisper 経路では `speaker` は使いません。Whisper 経路の処理は次のとおりです。

1. `whisper-1`（`response_format=verbose_json`）に音声を送り、言語を判定する。呼び出しに失敗した場合、または判定言語が空の場合は HTTP 502 `language detection failed` を返す
2. 判定言語を `whisperLangMatches` で選択言語と照合する。`whisperLangMatches` は `japanese` などの言語名と `ja` などの ISO コードの両方に対応し、`zh` は `zh-CN`、`zh-TW` に一致する
3. `WHISPER_MODEL`（未設定時は `gpt-4o-transcribe`）に音声を送り、文字起こしする。このとき翻訳元言語 ID の `-` より前の部分（`zh-CN` なら `zh`）を `language` として送り、言語別のプロンプト（`whisperPrompts`）を `prompt` として送る。失敗した場合は HTTP 502 `transcription failed` を返す

transcript 経路と Whisper 経路のどちらでも、翻訳元と翻訳先が決まった後に固有名詞保護の適用条件を判定します。固有名詞保護を使わない場合（この文書では「保護なし経路」と呼びます）は、翻訳 prompt で翻訳結果のテキストだけを返すよう指示して翻訳し、続けて別 prompt でバックトランスレーションを実行します。保護なし経路の `ttsText` は `translatedText` と同じです。

### 固有名詞保護との関係

`/api/interpret` は、次の条件に合う場合に `backend/propnoun.go` の固有名詞保護を使います。

- 翻訳元言語が `ja` で、原文に日本語文字が含まれる場合
- 翻訳先言語が `ja` 以外で、原文に英語自己紹介パターンが含まれる場合

「日本語文字」は、ひらがな、カタカナ、CJK 統合漢字、CJK Extension A のいずれかです（`hasJapaneseChars`）。漢字だけの文も日本語文字を含むと判定されます。

この条件は `/api/translate` の条件とは異なります。保護経路のプレースホルダ化、検証、リトライは `/api/translate` と同じです。固有名詞が 1 件も抽出されなかった場合や Kagome tokenizer の初期化・抽出に失敗した場合、入力テキストに `__GT_PROPN_` が含まれる場合、プレースホルダ化したテキストがプレースホルダ検証に通らない場合に保護なし経路へ進む点も同じですが、進んだ後の処理が異なります。`/api/interpret` は決めた翻訳方向のまま翻訳だけを行い、`language_mismatch` は返しません。`/api/translate` は OpenAI Responses API に翻訳元を判定させるため、`language_mismatch` を返すことがあります。詳細は [proper-noun-protection.md](proper-noun-protection.md) を参照してください。

## 6. POST /api/translate

| 項目 | 内容 |
| --- | --- |
| Method | `POST` |
| Path | `/api/translate` |
| 目的 | 入力テキストを選択済み 2 言語間で翻訳し、バックトランスレーションと TTS 用テキストを返す |
| Request Content-Type | `application/json` |
| Response Content-Type | `application/json` |

Frontend は録音中のリアルタイム翻訳と、原文を編集した後の再翻訳でこの API を使います。

Request body:

| Field | Type | 必須 | 内容 |
| --- | --- | --- | --- |
| `text` | string | yes | 翻訳対象テキスト。空白のみはエラー |
| `languages` | array | yes | 選択済み言語。2 件以上が必要 |
| `languages[].id` | string | yes | 言語 ID |
| `languages[].label` | string | yes | prompt に使う言語ラベル |

Request 例:

```json
{
  "text": "こんにちは",
  "languages": [
    { "id": "ja", "label": "Japanese" },
    { "id": "en", "label": "English" }
  ]
}
```

Response body:

| Field | Type | 内容 |
| --- | --- | --- |
| `sourceLanguage` | string | 翻訳元言語 ID |
| `targetLanguage` | string | 翻訳先言語 ID |
| `translatedText` | string | 表示用の翻訳結果 |
| `backTranslation` | string | 翻訳結果を翻訳元言語へ戻した文字列 |
| `ttsText` | string | `/api/tts` に渡す読み上げ用テキスト |

Response 例:

```json
{
  "sourceLanguage": "ja",
  "targetLanguage": "en",
  "translatedText": "Hello",
  "backTranslation": "こんにちは",
  "ttsText": "Hello"
}
```

### 翻訳方向の決定

`/api/translate` は request で翻訳元を受け取りません。Backend は実行経路に応じて翻訳元を決めます。

| 経路 | 条件 | 翻訳元と翻訳先 |
| --- | --- | --- |
| 保護経路 | 選択言語に `ja` があり、入力に日本語文字を含む | `ja` を翻訳元、もう一方を翻訳先にする |
| 保護経路 | 選択言語に `ja` がなく、入力に英語自己紹介パターンと日本語文字を含む | `languages[1]` を翻訳元、`languages[0]` を翻訳先にする |
| 保護経路 | 選択言語に `ja` がなく、入力に英語自己紹介パターンを含み、日本語文字を含まない | `languages[0]` を翻訳元、`languages[1]` を翻訳先にする |
| 保護なし経路 | 上記以外、または保護経路で固有名詞が 1 件も抽出されなかった場合、Kagome tokenizer の初期化・抽出に失敗した場合、入力テキストに `__GT_PROPN_` が含まれる場合、プレースホルダ化したテキストがプレースホルダ検証に通らない場合 | OpenAI Responses API の JSON 応答の `sourceLanguage` を翻訳元にし、`lang0`、`lang1` のうち翻訳元でない方を翻訳先にする |

保護経路の行は、固有名詞が 1 件以上抽出された場合だけに当てはまります。選択言語に `ja` がある場合、保護経路に入るには入力に日本語文字が必要なため、英語自己紹介パターンだけでは保護経路に入りません。

「日本語文字」は、ひらがな、カタカナ、CJK 統合漢字、CJK Extension A のいずれかです（`hasJapaneseChars`）。漢字だけの文も日本語文字を含むと判定されます。たとえば `ja` と `zh-CN` を選択して中国語の文を送り、固有名詞が 1 件以上抽出された場合は、保護経路で `ja` が翻訳元、`zh-CN` が翻訳先になります。この場合は OpenAI による言語判定を行わないため、`language_mismatch` は返りません。

保護なし経路では、OpenAI Responses API の JSON 応答の `targetLanguage` はログに出力するだけで、翻訳先の決定には使いません。OpenAI の判定した `sourceLanguage` が `unknown`、または選択済み 2 言語のどちらでもない場合は HTTP 422 で `language_mismatch` を返します。

### languages

`languages` は 2 件以上が必要です。実装では先頭 2 件を `lang0`、`lang1` として使います。2 件未満の場合は HTTP 400 で `two languages are required` を返します。

### translatedText

`translatedText` は Frontend が翻訳カードに表示する文字列です。固有名詞保護が有効な場合は、翻訳先言語 ID に合わせてプレースホルダ復元した文字列になります。保護なし経路では OpenAI Responses API の翻訳結果から外側の引用符を除去した文字列になります。

### backTranslation

`backTranslation` は翻訳後に別 prompt で実行したバックトランスレーション結果です。固有名詞保護が有効な場合は、バックトランスレーション結果もプレースホルダ検証と復元の対象になります。

### ttsText

`ttsText` は Frontend が読み上げ時に `/api/tts` へ送る文字列です。保護なし経路では `translatedText` と同じです。固有名詞保護が有効な場合は、翻訳結果の raw text を TTS 用に復元した文字列になります。

### 固有名詞保護との関係

`/api/translate` は、条件に合う場合に `backend/propnoun.go` の固有名詞保護を使います。

- 選択言語のどちらかが `ja` で、入力に日本語文字が含まれる場合
- 選択言語のどちらも `ja` ではなく、英語自己紹介パターンを含む場合

日本語文字には CJK 統合漢字も含まれるため、中国語の文もこの条件に当てはまることがあります（「翻訳方向の決定」を参照）。

保護経路では、固有名詞を `__GT_PROPN_NNN__` 形式のプレースホルダに置き換えて OpenAI Responses API に渡します。翻訳結果とバックトランスレーション結果の両方でプレースホルダを検証し、必要に応じて各段階で 1 回だけリトライします。

固有名詞が抽出されなかった場合、Kagome tokenizer の初期化・抽出に失敗した場合、入力テキストに `__GT_PROPN_` が含まれる場合、またはプレースホルダ化したテキストがプレースホルダ検証に通らない場合は、保護なし経路へ進みます。プレースホルダ検証が再試行後も失敗した場合は HTTP 502 で `proper_noun_protection_failed` を返します。

## 7. POST /api/tts

| 項目 | 内容 |
| --- | --- |
| Method | `POST` |
| Path | `/api/tts` |
| 目的 | テキストを読み上げ音声に変換する |
| Request Content-Type | `application/json` |
| Response Content-Type | `audio/mpeg` |

Request body:

| Field | Type | 必須 | 内容 |
| --- | --- | --- | --- |
| `text` | string | yes | 読み上げ対象テキスト。空白のみはエラー |

Request 例:

```json
{
  "text": "Hello"
}
```

成功時は OpenAI Audio Speech API から返った音声 bytes を `audio/mpeg` として返します。

OpenAI Audio Speech API へ送る値は次のとおりです。

| Field | 値 |
| --- | --- |
| `model` | `OPENAI_TTS_MODEL`。未設定時は `gpt-4o-mini-tts` |
| `input` | request body の `text` |
| `voice` | `OPENAI_TTS_VOICE`。未設定時は `marin` |

OpenAI Audio Speech API の呼び出しに失敗した場合は HTTP 502 で `tts failed` を返します。

## 8. エラー仕様

### /api/interpret

| 条件 | HTTP status | Response |
| --- | --- | --- |
| `POST` 以外 | 405 | `method not allowed` |
| `OPENAI_API_KEY` 未設定 | 500 | `{"error":"service unavailable"}` |
| multipart form の parse 失敗 | 400 | `{"error":"invalid multipart form"}` |
| `audio` がない | 400 | `{"error":"audio is required"}` |
| 音声データの読み込み失敗 | 500 | `{"error":"failed to read audio"}` |
| `myLanguage` の JSON が不正、または `id` が空 | 400 | `{"error":"invalid myLanguage"}` |
| `theirLanguage` の JSON が不正、または `id` が空 | 400 | `{"error":"invalid theirLanguage"}` |
| `transcript` があり、`speaker` が選択言語のどちらにも一致しない | 400 | `{"error":"invalid speaker"}` |
| `whisper-1` の呼び出し失敗、または判定言語が空 | 502 | `{"error":"language detection failed"}` |
| 判定言語が選択言語のどちらにも一致しない | 422 | `{"error":"language_mismatch"}` |
| 文字起こしの呼び出し失敗 | 502 | `{"error":"transcription failed"}` |
| 翻訳またはバックトランスレーションの OpenAI Responses API 呼び出し失敗 | 502 | `{"error":"translation failed"}` |
| 固有名詞保護のプレースホルダ検証が再試行後も失敗 | 502 | `{"error":"proper_noun_protection_failed"}` |

`POST` 以外の 405 は `http.Error` による応答です。それ以外の表内の JSON error は `writeError` による応答です。

### /api/translate

| 条件 | HTTP status | Response |
| --- | --- | --- |
| `POST` 以外 | 405 | `method not allowed` |
| `OPENAI_API_KEY` 未設定 | 500 | `{"error":"translation service unavailable"}` |
| request body の JSON decode 失敗 | 400 | `{"error":"invalid request body"}` |
| `text` が空白のみ | 400 | `{"error":"text is required"}` |
| `languages` が 2 件未満 | 400 | `{"error":"two languages are required"}` |
| OpenAI Responses API 呼び出し失敗 | 502 | `{"error":"translation failed"}` |
| OpenAI の JSON 応答 parse 失敗 | 502 | `{"error":"translation failed"}` |
| 保護なし経路で翻訳元言語が候補外または `unknown` | 422 | `{"error":"language_mismatch"}` |
| 固有名詞保護のプレースホルダ検証が再試行後も失敗 | 502 | `{"error":"proper_noun_protection_failed"}` |

`POST` 以外の 405 は `http.Error` による応答です。それ以外の表内の JSON error は `writeError` による応答です。

### /api/tts

| 条件 | HTTP status | Response |
| --- | --- | --- |
| `POST` 以外 | 405 | `method not allowed` |
| `OPENAI_API_KEY` 未設定 | 500 | `{"error":"service unavailable"}` |
| request body の JSON decode 失敗 | 400 | `{"error":"invalid request body"}` |
| `text` が空白のみ | 400 | `{"error":"text is required"}` |
| OpenAI Audio Speech API 呼び出し失敗 | 502 | `{"error":"tts failed"}` |

### /health

`/health` は実装上、HTTP method によるエラー分岐を持ちません。CORS middleware が `OPTIONS` を 204 で処理し、それ以外は `{"status":"ok"}` を返します。

## 9. Frontend からの利用

Frontend の API 呼び出しは `frontend/src/pages/InterpreterPage.tsx` に実装されています。

| 利用経路 | 関数 | API | 送信内容 | タイムアウト |
| --- | --- | --- | --- | --- |
| 録音終了後の確定翻訳 | `callInterpretApi` | `POST /api/interpret` | `audio`、`myLanguage`、`theirLanguage`、`speaker`、認識テキストがあれば `transcript` | 60 秒 |
| 録音中のリアルタイム翻訳 | `useEffect` 内の処理 | `POST /api/translate` | `text`、`languages` | なし |
| 原文編集後の再翻訳 | `callTranslateApi` | `POST /api/translate` | `text`、`languages` | 30 秒 |
| TTS 再生 | `handleSpeak` | `POST /api/tts` | `text: ttsText` | なし |

確定翻訳は、録音を止めたときに `MediaRecorder` の `onstop` から `callInterpretApi(blob)` で実行されます。Frontend はタップされた国旗の言語を `myLanguage` と `speaker`、もう一方の言語を `theirLanguage` として送ります。録音中に `SpeechRecognition` の認識テキストが得られていれば `transcript` として添えます。成功レスポンスから `translatedText`、`backTranslation`、`ttsText` を state に保存します。録音中に `SpeechRecognition` の `onresult` が一度も呼ばれなかった場合（`hasLiveTranscriptRef.current` が `false`）は、`text` を原文として表示します。`onresult` は呼ばれたが認識テキストが空だった場合は、`transcript` を送らず、`text` も原文として表示しません。`ttsText` がない場合は `translatedText` を読み上げ用テキストとして使います。

リアルタイム翻訳は録音中に `recognizedText` の変更に対して 800ms のデバウンスで実行されます。成功し、`translatedText` が存在し、`sourceLanguage` が `unknown` でない場合に `liveTranslatedText` を更新します。リアルタイム翻訳中の abort や network error は UI エラーとして表示しません。

再翻訳は、原文を編集して確定した場合に `callTranslateApi(trimmed)` で実行されます。翻訳方向は Backend が決めます。

`/api/interpret` と `/api/translate`（再翻訳）が HTTP 422 で `language_mismatch` を返した場合、Frontend は選択言語ごとの言語不明メッセージを表示し、翻訳文とバックトランスレーションを空にして `idle` に戻します。

TTS 再生は読み上げボタンから実行されます。Frontend は `/api/tts` の `audio/mpeg` response から object URL を作成し、`Audio` で再生します。

## 10. OpenAI API との関係

Backend は OpenAI API を 3 系統で使います。

| 用途 | API | endpoint | モデル |
| --- | --- | --- | --- |
| 言語判定（`/api/interpret` の Whisper 経路） | Audio Transcriptions API | `/v1/audio/transcriptions` | `whisper-1` 固定（環境変数で変更不可） |
| 文字起こし（`/api/interpret` の Whisper 経路） | Audio Transcriptions API | `/v1/audio/transcriptions` | `WHISPER_MODEL`。未設定時は `gpt-4o-transcribe` |
| 翻訳 | Responses API | `/v1/responses` | `OPENAI_MODEL`。未設定時は `gpt-4o-mini` |
| バックトランスレーション | Responses API | `/v1/responses` | `OPENAI_MODEL`。未設定時は `gpt-4o-mini` |
| TTS | Audio Speech API | `/v1/audio/speech` | `OPENAI_TTS_MODEL`。未設定時は `gpt-4o-mini-tts` |

Audio Transcriptions API 呼び出し（`callWhisper`）では、multipart form で `file`、`model`、`response_format` を送り、指定がある場合は `language` と `prompt` も送ります。`response_format` はモデル名が `whisper-1` のときだけ `verbose_json`、それ以外は `json` です。成功時は response の `text` と `language` を使います。HTTP 200 以外、JSON decode 失敗、HTTP client の失敗は呼び出し失敗として扱います。

Responses API 呼び出しでは、request body に `model` と `input` を送ります。成功時は response の `output[0].content[0].text` を使います。HTTP 200 以外、JSON decode 失敗、空 response は呼び出し失敗として扱います。

Audio Speech API 呼び出しでは、request body に `model`、`input`、`voice` を送ります。成功時は response body をそのまま `audio/mpeg` として Frontend に返します。HTTP 200 以外または HTTP client の失敗は `tts failed` になります。

## 11. 関連ドキュメント

- [architecture.md](architecture.md)
- [translation-flow.md](translation-flow.md)
- [speech-flow.md](speech-flow.md)
- [proper-noun-protection.md](proper-noun-protection.md)
