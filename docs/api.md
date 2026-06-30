# Backend API

## 1. 概要

GoTalk Backend API は、Frontend から送られる認識済みテキストを受け取り、翻訳、バックトランスレーション、読み上げ音声生成を実行する API です。

Backend は OpenAI API キーをサーバー側だけで扱います。Frontend は OpenAI API を直接呼び出さず、Backend の `/api/translate` と `/api/tts` を呼び出します。

Backend の主な役割は次のとおりです。

- Frontend からの翻訳リクエストを受ける
- OpenAI Responses API を使って翻訳とバックトランスレーションを行う
- 必要な場合に固有名詞保護を適用する
- OpenAI Audio Speech API を使って TTS を行う
- OpenAI API キーを Backend 側だけで扱う

## 2. API 一覧

| Method | Path | 概要 |
| --- | --- | --- |
| `GET` | `/health` | ヘルスチェック |
| `POST` | `/api/translate` | 翻訳・バックトランスレーション |
| `POST` | `/api/tts` | TTS |

## 3. 共通仕様

Backend は Go の `net/http` で実装されています。`main()` では次の route を登録します。

- `/health`
- `/api/translate`
- `/api/tts`

CORS middleware は全 API に適用されます。

| Header | 値 |
| --- | --- |
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type` |

`OPTIONS` request は handler に渡さず、HTTP 204 を返します。

`/api/translate` と `/api/tts` は JSON request body を受け取ります。Frontend はどちらも `Content-Type: application/json` を付けて送信します。

JSON error response は次の形式です。

```json
{
  "error": "error message"
}
```

`writeError` を使うエラーでは `Content-Type: application/json` が設定されます。`/api/translate` と `/api/tts` の許可されない HTTP method は `http.Error` で処理され、HTTP 405 と本文 `method not allowed` を返します。

OpenAI API キーは `OPENAI_API_KEY` から読みます。未設定時の扱いは API ごとに異なります。

| API | HTTP status | Response |
| --- | --- | --- |
| `/api/translate` | 500 | `{"error":"translation service unavailable"}` |
| `/api/tts` | 500 | `{"error":"service unavailable"}` |

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

## 5. POST /api/translate

| 項目 | 内容 |
| --- | --- |
| Method | `POST` |
| Path | `/api/translate` |
| 目的 | 入力テキストを選択済み 2 言語間で翻訳し、バックトランスレーションと TTS 用テキストを返す |
| Request Content-Type | `application/json` |
| Response Content-Type | `application/json` |

Request body:

| Field | Type | 必須 | 内容 |
| --- | --- | --- | --- |
| `text` | string | yes | 翻訳対象テキスト。空白のみはエラー |
| `languages` | array | yes | 選択済み言語。2 件以上が必要 |
| `languages[].id` | string | yes | 言語 ID |
| `languages[].label` | string | yes | prompt に使う言語ラベル |
| `sourceLanguage` | string | no | 翻訳元言語 ID。指定時は `languages` のどちらかに一致する必要がある |

Request 例:

```json
{
  "text": "こんにちは",
  "languages": [
    { "id": "ja", "label": "Japanese" },
    { "id": "en", "label": "English" }
  ],
  "sourceLanguage": "ja"
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

### sourceLanguage

`sourceLanguage` が指定された場合、Backend はその ID を翻訳元として扱います。指定値が `languages[0].id` に一致する場合は `languages[0]` が翻訳元、`languages[1]` が翻訳先です。指定値が `languages[1].id` に一致する場合は逆になります。

`sourceLanguage` が指定され、選択済み 2 言語のどちらにも一致しない場合は HTTP 400 で `sourceLanguage not in selected languages` を返します。

`sourceLanguage` が未指定の場合、Backend は実行経路に応じて翻訳元を決めます。

| 経路 | 翻訳元の決定 |
| --- | --- |
| 固有名詞保護経路で入力に日本語文字を含む | `ja` を翻訳元にする |
| 固有名詞保護経路で日本語文字を含まず自己紹介パターンを含む | 非日本語側を翻訳元にする。選択言語に `ja` がない場合は `languages[0]` を翻訳元にする |
| 通常経路 | OpenAI Responses API の JSON 応答から `sourceLanguage` と `targetLanguage` を取得する |

通常経路で OpenAI の判定結果が `unknown`、または選択済み 2 言語のどちらでもない場合は HTTP 422 で `language_mismatch` を返します。

### languages

`languages` は 2 件以上が必要です。実装では先頭 2 件を `lang0`、`lang1` として使います。2 件未満の場合は HTTP 400 で `two languages are required` を返します。

### translatedText

`translatedText` は Frontend が翻訳カードに表示する文字列です。固有名詞保護が有効な場合は、翻訳先言語 ID に合わせてプレースホルダ復元した文字列になります。通常経路では OpenAI Responses API の翻訳結果から外側の引用符を除去した文字列になります。

### backTranslation

`backTranslation` は翻訳後に別 prompt で実行したバックトランスレーション結果です。固有名詞保護が有効な場合は、バックトランスレーション結果もプレースホルダ検証と復元の対象になります。

### ttsText

`ttsText` は Frontend が読み上げ時に `/api/tts` へ送る文字列です。通常経路では `translatedText` と同じです。固有名詞保護が有効な場合は、翻訳結果の raw text を TTS 用に復元した文字列になります。

### 固有名詞保護との関係

`/api/translate` は、条件に合う場合に `backend/propnoun.go` の固有名詞保護を使います。

- 選択言語のどちらかが `ja` で、入力に日本語文字が含まれる場合
- 選択言語のどちらも `ja` ではなく、英語自己紹介パターンを含む場合

保護経路では、固有名詞を `__GT_PROPN_NNN__` 形式のプレースホルダに置き換えて OpenAI Responses API に渡します。翻訳結果とバックトランスレーション結果の両方でプレースホルダを検証し、必要に応じて各段階で 1 回だけリトライします。

固有名詞が抽出されなかった場合、または Kagome tokenizer の初期化・抽出に失敗した場合は、通常翻訳へ進みます。プレースホルダ検証が再試行後も失敗した場合は HTTP 502 で `proper_noun_protection_failed` を返します。

## 6. POST /api/tts

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

## 7. エラー仕様

### /api/translate

| 条件 | HTTP status | Response |
| --- | --- | --- |
| `POST` 以外 | 405 | `method not allowed` |
| `OPENAI_API_KEY` 未設定 | 500 | `{"error":"translation service unavailable"}` |
| request body の JSON decode 失敗 | 400 | `{"error":"invalid request body"}` |
| `text` が空白のみ | 400 | `{"error":"text is required"}` |
| `languages` が 2 件未満 | 400 | `{"error":"two languages are required"}` |
| `sourceLanguage` が選択済み言語に含まれない | 400 | `{"error":"sourceLanguage not in selected languages"}` |
| OpenAI Responses API 呼び出し失敗 | 502 | `{"error":"translation failed"}` |
| OpenAI の JSON 応答 parse 失敗 | 502 | `{"error":"translation failed"}` |
| 通常経路で翻訳元言語が候補外または `unknown` | 422 | `{"error":"language_mismatch"}` |
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

## 8. Frontend からの利用

Frontend の API 呼び出しは `frontend/src/pages/InterpreterPage.tsx` に実装されています。

| 利用経路 | API | 送信内容 | `sourceLanguage` |
| --- | --- | --- | --- |
| 音声入力中リアルタイム翻訳 | `POST /api/translate` | `text`, `languages` | `recordingLangRef.current` がある場合に送る |
| 音声入力終了後の確定翻訳 | `POST /api/translate` | `text`, `languages` | 音声入力開始時にタップされた国旗の言語 ID を送る |
| 手入力再翻訳 | `POST /api/translate` | `text`, `languages` | 送らない |
| TTS 再生 | `POST /api/tts` | `text: ttsText` | 対象外 |

リアルタイム翻訳は `recognizedText` の変更に対して 800ms のデバウンスで実行されます。成功し、`translatedText` が存在し、`sourceLanguage` が `unknown` でない場合に `liveTranslatedText` を更新します。リアルタイム翻訳中の abort や network error は UI エラーとして表示しません。

確定翻訳は音声入力終了時に `callTranslateApi(transcript, recordingLangRef.current?.id)` で実行されます。Frontend は成功レスポンスから `translatedText`、`backTranslation`、`ttsText` を state に保存します。`ttsText` がない場合は `translatedText` を読み上げ用テキストとして使います。

手入力再翻訳は、認識テキストを編集して確定した場合に `callTranslateApi(trimmed)` で実行されます。この経路では `sourceLanguage` を送らないため、Backend が翻訳方向を決めます。

TTS 再生は読み上げボタンから実行されます。Frontend は `/api/tts` の `audio/mpeg` response から object URL を作成し、`Audio` で再生します。

## 9. OpenAI API との関係

Backend は OpenAI API を 2 系統で使います。

| 用途 | API | endpoint | モデル |
| --- | --- | --- | --- |
| 翻訳 | Responses API | `/v1/responses` | `OPENAI_MODEL`。未設定時は `gpt-4o-mini` |
| バックトランスレーション | Responses API | `/v1/responses` | `OPENAI_MODEL`。未設定時は `gpt-4o-mini` |
| TTS | Audio Speech API | `/v1/audio/speech` | `OPENAI_TTS_MODEL`。未設定時は `gpt-4o-mini-tts` |

Responses API 呼び出しでは、request body に `model` と `input` を送ります。成功時は response の `output[0].content[0].text` を使います。HTTP 200 以外、JSON decode 失敗、空 response は呼び出し失敗として扱います。

Audio Speech API 呼び出しでは、request body に `model`、`input`、`voice` を送ります。成功時は response body をそのまま `audio/mpeg` として Frontend に返します。HTTP 200 以外または HTTP client の失敗は `tts failed` になります。

## 10. 関連ドキュメント

- [architecture.md](architecture.md)
- [translation-flow.md](translation-flow.md)
- [speech-flow.md](speech-flow.md)
- [proper-noun-protection.md](proper-noun-protection.md)
