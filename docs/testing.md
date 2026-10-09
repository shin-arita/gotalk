# Testing

## 1. テスト方針

GoTalk のテストは Backend と Frontend を分けて実行します。

Backend は Go 標準の `go test` で、HTTP handler、OpenAI API 呼び出し wrapper（文字起こし、翻訳、TTS）、言語判定結果の照合、固有名詞保護、バックトランスレーション、API エラーを検証します。外部 API へ実通信しないよう、テストでは `http.DefaultClient.Transport` を mock transport に差し替えます。

Frontend は Vitest、Testing Library、jsdom で、言語選択、国旗ボタンによる録音フロー、`/api/interpret` への送信内容、翻訳結果表示、バックトランスレーション表示、再翻訳、TTS、状態遷移、エラー処理を検証します。

## 2. Backend テスト

Backend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `backend/main_test.go` | `whisperLangMatches`、共通 helper、health、CORS、固有名詞抽出補助 |
| `backend/main_handlers_test.go` | `/api/interpret`、`/api/translate`、`/api/tts`、OpenAI 呼び出し、固有名詞保護 |

実行コマンド:

```bash
cd backend
go test ./...
```

主な検証対象:

- `/health` が JSON で `{"status":"ok"}` を返すこと
- `writeError` が JSON error response を返すこと
- CORS middleware が通常 request と `OPTIONS` request を処理すること
- `extractJSON` が OpenAI response から JSON 部分を取り出すこと
- `whisperLangMatches` が言語名（`japanese` など）と ISO コード（`ja` など）の両方で選択言語と照合できること（`TestWhisperLangMatches`）
- `callWhisper` が `whisper-1` と `gpt-4o-transcribe` の正常系、非 200、invalid JSON、transport error を扱うこと（`TestCallWhisper_*` 5 件）
- `callOpenAI` が transport error、非 200、invalid JSON、空 output、空 content、正常系を扱うこと
- `/api/interpret` が method、API key 未設定、invalid multipart、`audio` なし、`myLanguage` / `theirLanguage` の不正と空 ID、言語判定エラー、判定言語が空、`language_mismatch`、文字起こしエラー、翻訳エラー、翻訳結果が JSON でない場合、`myLanguage` / `theirLanguage` それぞれに一致した場合の正常系、英語自己紹介名を扱うこと（`TestInterpretHandler_*` 17 件）
- `/api/interpret` の transcript 経路で、翻訳 prompt が speech recognition error の補正や固有名詞の生成を禁止する文言を含むこと（`TestInterpretHandler_TranscriptPath_PromptForbidsSpeechCorrection`）
- `/api/translate` が method、API key 未設定、invalid JSON、空 text、`languages` 不足、OpenAI error、invalid translation JSON、`language_mismatch`、正常系を扱うこと
- `/api/translate` の翻訳 prompt が speech recognition error や固有名詞の過剰補正を禁止する文言を含むこと
- 固有名詞保護で博多、博多駅、有田シン、ドン・キホーテなどが placeholder 化され、翻訳結果と `ttsText` に復元されること
- placeholder が翻訳時に欠落した場合、1 回 retry して成功または 502 になること
- placeholder がバックトランスレーション時に欠落した場合、retry すること
- 英語自己紹介名の抽出条件と intro pattern 判定
- `/api/tts` が method、API key 未設定、invalid JSON、空 text、OpenAI error、非 200、正常系を扱うこと
- `callOpenAITTS` が正常系、transport error、非 200 を扱うこと

バックトランスレーションは `/api/interpret` と `/api/translate` の中で翻訳後に別 OpenAI call として実行されます。テストでは mock transport の call count や返却値を使い、言語判定 call、文字起こし call、翻訳 call、バックトランスレーション call を検証します。

## 3. Frontend テスト

Frontend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `frontend/src/languages.test.ts` | 言語定義 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、録音、確定翻訳、再翻訳、TTS、状態遷移 |

実行コマンド:

```bash
cd frontend
npm test
```

主な検証対象:

- `LANGUAGES` が 7 件で、各言語の `id`、`speechCode`、`label` が定義されていること
- 言語 ID が一意であること
- 言語選択画面が全言語カードを表示すること
- 言語カードの選択、解除、3 言語目を追加しない制御
- 2 言語目選択時の navigation callback
- 国旗ボタンが選択言語ごとに表示されること
- `MediaRecorder` と `getUserMedia` の mock を使った、国旗タップによる録音開始・停止
- 録音中の反対側の国旗の disabled、録音完了後の再有効化
- 同じ国旗の再タップで録音を停止し、`/api/interpret` を呼ぶこと
- 左右どちらの国旗で録音したかに応じて、その言語を `speaker` と `myLanguage`、もう一方を `theirLanguage` として送ること
- `getUserMedia` が失敗した場合にマイクアクセスのエラーを表示すること
- `/api/interpret` が 422 `language_mismatch` を返した場合に、選択言語ごとの言語不明メッセージを表示し、翻訳文を空にして `idle` に戻すこと（3 件）
- 確定翻訳の成功時に `translatedText`、`backTranslation`、読み上げボタン、履歴を表示すること
- `/api/interpret` が 500 を返した場合のエラー表示
- 再翻訳で `/api/translate` が 422 `language_mismatch` を返した場合のエラー表示
- 再翻訳で `/api/translate` が 500 を返した場合のエラー表示と、直前の翻訳文と読み上げボタンが残ること
- `/api/tts` に `ttsText` を送ること
- TTS fetch 中の button disabled、audio `onended` 後の復帰、TTS 失敗後の復帰
- `recording` 中は翻訳カードを隠し、録音終了後に表示すること

`/api/interpret` の結果表示やエラー処理のテストの多くは、`InterpreterPage` の `pendingAudio` prop に `Blob` を渡して `callInterpretApi` を起動します。国旗タップのテストでは `MediaRecorder` と `navigator.mediaDevices.getUserMedia` を mock します。`SpeechRecognition` は mock していないため、これらのテストでは `transcript` は送られません。

Frontend の TTS テストでは `Audio`、`URL.createObjectURL`、`URL.revokeObjectURL` を mock します。API 呼び出しは `fetch` mock で検証します。

## 4. テスト対象

現在の実装でテスト対象になっている主な機能は次のとおりです。

| 領域 | 対象 |
| --- | --- |
| Backend API | `/health`、`/api/interpret`、`/api/translate`、`/api/tts` |
| 文字起こし | OpenAI Audio Transcriptions API wrapper、言語判定結果の照合、`language_mismatch` |
| 翻訳 | OpenAI Responses API wrapper、翻訳 prompt、JSON response parse |
| 翻訳方向 | `/api/interpret` の判定言語による方向決定、`/api/translate` の `language_mismatch` |
| 固有名詞保護 | Kagome 抽出、英語自己紹介 pattern、placeholder、retry、復元、`ttsText` |
| バックトランスレーション | 翻訳後の back-translation call、placeholder 検証と retry |
| TTS | OpenAI Audio Speech API wrapper、`audio/mpeg` response、TTS error |
| Frontend 録音 | `MediaRecorder`、`getUserMedia`、国旗ボタンによる録音フロー |
| Frontend API 利用 | `/api/interpret`（`speaker`、`myLanguage`、`theirLanguage`）、`/api/translate`、`/api/tts`、`language_mismatch` |
| Frontend UI | 翻訳結果、バックトランスレーション、履歴、読み上げボタン、エラー表示 |

## 5. ビルド確認

Backend build:

```bash
cd backend
go build -o /tmp/gotalk-backend .
```

Frontend build:

```bash
cd frontend
npm run build
```

Frontend の `npm run build` は `tsc -b && vite build` を実行します。

## 6. backend-dev

Docker Compose には Backend 開発用の `backend-dev` service があります。`./backend` を `/app` に mount し、Go command を実行できます。

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

`backend-dev` は port を公開しません。通常の API server 起動は `backend` service を使います。

## 7. CI

CI では Backend と Frontend の検証を分けて実行します。

Frontend:

- `npm run lint`
- `npm run test`
- `npm run test:coverage`
- `npm run build`

Backend:

- `go vet ./...`
- `go test ./...`
- `go build -o /tmp/gotalk-backend .`

## 8. 関連ドキュメント

- [architecture.md](architecture.md)
- [translation-flow.md](translation-flow.md)
- [speech-flow.md](speech-flow.md)
- [proper-noun-protection.md](proper-noun-protection.md)
- [api.md](api.md)
