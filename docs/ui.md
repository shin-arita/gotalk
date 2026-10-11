# UI

## 1. 利用者向けの文言の言語

画面で利用者に表示する案内、警告、エラーなどの文言は、原則として、今選ばれている2つの言語で表示します。

表示の順は言語を選んだ順とし、2つの文言の間には空行を入れます。

対応する文言がない言語は、英語で表示します。

HTTP の status、内部のエラーコード、OpenAI などの内部の情報は、利用者向けの文言として直接表示しません（必要な情報はログに残します）。

利用者向けの文言は、共通の関数を通して表示します。新しい文言を加えるときは、7言語（`ja`、`en`、`zh-CN`、`zh-TW`、`ko`、`th`、`vi`）の文言を用意します。

## 2. 共通の関数

共通の関数は `frontend/src/messages.ts` の `getLocalizedMessage(messageKey, language1, language2)` です。文言の辞書（`MESSAGES`）と、文言のキーの型（`MessageKey`）も同じファイルにあります。

- `messageKey` の文言を、`language1` と `language2`（言語の `id`）の順に取り、空行（`\n\n`）をはさんで連結します
- 辞書にその言語の文言がない場合は、英語の文言を使います
- 選んだ言語が1つだけの場合は、その言語の文言だけを返します。1つもない場合は、英語の文言を返します

通訳画面（`frontend/src/pages/InterpreterPage.tsx`）では、`showMessage(messageKey)` が、選んだ2つの言語（`selectedLanguages` の順）で `getLocalizedMessage` を呼び、エラーの表示の位置（`role="alert"`）に表示します。

API のエラーは、日本語の文字列ではなく `ApiError`（`frontend/src/api.ts`）の `messageKey` で扱い、表示の直前に文言にします。デバッグのため、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`TypeError` などのエラーの名前）を残します。発話の内容、翻訳の結果、音声のデータ、`e.message`、Backend の `error` の文字列はログにも残しません。

## 3. 文言のキーと出る場面

| キー | 文言（日本語） | 出る場面 |
| --- | --- | --- |
| `input_too_large` | 入力が長すぎます。短くしてもう一度お試しください | Backend の `input_too_large`（`/api/interpret` の 400、`/api/translate` の 400 と 413）。`/api/interpret` の 413 と `/api/tts` の場合を除く |
| `service_unavailable` | 現在サービスを利用できません | Backend の `service_unavailable`（503） |
| `upstream_busy` | 混み合っています。しばらくしてからお試しください | Backend の `upstream_busy`（503） |
| `timeout` | 処理に時間がかかっています。もう一度お試しください | Backend の `timeout`（504） |
| `tts_too_long` | この翻訳は長いため、読み上げできません（500文字まで） | 読み上げる翻訳が 500 文字を超える場合（Frontend の確認）と、`/api/tts` の `input_too_large`。500 は `TTS_MAX_CHARS` から作ります |
| `recording_too_long` | 録音が長すぎます。短く区切って話してください。 | `/api/interpret` の 413（本文の形式によらない）と、送る前の録音のサイズの確認で上限を超えた場合 |
| `microphone_denied` | マイクへのアクセスが許可されていません | `getUserMedia` や `MediaRecorder` の作成に失敗した場合 |
| `generic_error` | エラーが発生しました。もう一度お試しください。 | 対応する文言がない status や `code`（502 `upstream_error` など）、ネットワークのエラー（`fetch` の reject）、応答が JSON として読めない場合など |
| `language_unclear` | 言語不明、もう一度お話ください | `/api/interpret` と `/api/translate`（再翻訳）の 422 `language_mismatch` |
| `request_timeout` | うまく翻訳できませんでした。もう一度お願いします。 | Frontend の `fetch` の timeout（`AbortController` の abort。`/api/interpret` は 65 秒、再翻訳の `/api/translate` は 30 秒）。Backend の 504（`timeout`）とは別の文言です |

7言語の文言は `frontend/src/messages.ts` の `MESSAGES` を参照してください。

読み上げ（`/api/tts`）のエラーは、`tts_too_long`、`service_unavailable`、`upstream_busy`、`timeout` の場合だけ表示します。表示する文言がないエラー（502、ネットワークのエラー、timeout など）では何も表示せず、ログにだけ残します。録音中のリアルタイム翻訳の失敗も表示しません。

## 4. まだ共通の関数に寄せていない文言

次の既存の案内の文言は、`frontend/src/pages/InterpreterPage.tsx` の中に言語ごとの辞書を持ち、それぞれの書き方で表示しています。今後、順次、共通の関数に寄せます。

- 「ただいま翻訳中です」（`TRANSLATING_MESSAGES`）、「しばらくお待ちください」（`PLEASE_WAIT_MESSAGES`）：処理中の表示。話した人の言語、相手の言語の順に、改行1つで並べます
- 「国旗をタップして話してください」（`FLAG_TAP_MESSAGES`）：それぞれの国旗の上と下に、その国旗の言語で表示します
- 「話し終わったらもう一度国旗をタップして終了してください」（`FLAG_FINISH_MESSAGES`）：録音中の国旗の言語で表示します
- 逆翻訳の見出し（`BACK_TRANSLATION_LABELS`）：選んだ2つの言語を ` / ` で並べます

## 5. 関連ドキュメント

- [api.md](api.md)
- [speech-flow.md](speech-flow.md)
- [translation-flow.md](translation-flow.md)
- [testing.md](testing.md)
