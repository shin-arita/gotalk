# Testing

## 1. テスト方針

GoTalk のテストは Backend と Frontend を分けて実行します。

Backend は Go 標準の `go test` で、HTTP handler、OpenAI API 呼び出し wrapper、固有名詞保護、`sourceLanguage`、バックトランスレーション、TTS、API エラーを検証します。外部 API へ実通信しないよう、テストでは `http.DefaultClient.Transport` を mock transport に差し替えます。

Frontend は Vitest、Testing Library、jsdom で、言語選択、`SpeechRecognition` を使う音声入力フロー、リアルタイム翻訳、`sourceLanguage` 送信、翻訳結果表示、バックトランスレーション表示、TTS、状態遷移、エラー処理を検証します。

## 2. Backend テスト

Backend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `backend/main_test.go` | 共通 helper、health、CORS、固有名詞抽出補助 |
| `backend/main_handlers_test.go` | `/api/translate`、`/api/tts`、OpenAI 呼び出し、固有名詞保護、`sourceLanguage` |

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
- `callOpenAI` が transport error、非 200、invalid JSON、空 output、空 content、正常系を扱うこと
- `/api/translate` が method、API key 未設定、invalid JSON、空 text、`languages` 不足、OpenAI error、invalid translation JSON、`language_mismatch`、正常系を扱うこと
- `sourceLanguage` が不正な場合に 400 を返し、OpenAI を呼ばないこと
- `sourceLanguage` が指定された場合に翻訳方向を固定すること
- `sourceLanguage` 指定時にも固有名詞保護経路が動くこと
- 翻訳 prompt が speech recognition error や固有名詞の過剰補正を禁止する文言を含むこと
- 固有名詞保護で博多、博多駅、有田シン、ドン・キホーテなどが placeholder 化され、翻訳結果と `ttsText` に復元されること
- placeholder が翻訳時に欠落した場合、1 回 retry して成功または 502 になること
- placeholder がバックトランスレーション時に欠落した場合、retry すること
- 英語自己紹介名の抽出条件と intro pattern 判定
- `/api/tts` が method、API key 未設定、invalid JSON、空 text、OpenAI error、非 200、正常系を扱うこと
- `callOpenAITTS` が正常系、transport error、非 200 を扱うこと

バックトランスレーションは `/api/translate` の中で翻訳後に別 OpenAI call として実行されます。テストでは mock transport の call count や返却値を使い、翻訳 call とバックトランスレーション call の両方を検証します。

## 3. Frontend テスト

Frontend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `frontend/src/languages.test.ts` | 言語定義 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、音声入力、翻訳、TTS、状態遷移 |

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
- `SpeechRecognition` / `webkitSpeechRecognition` mock を使った音声入力開始・停止
- 国旗ボタンごとの音声入力開始、反対側の国旗の disabled、音声入力完了後の再有効化
- 空 transcript の場合に `/api/translate` を呼ばず、エラーを表示すること
- 音声入力終了後に `/api/translate` へ transcript、`languages`、`sourceLanguage` を送ること
- 右側の国旗で音声入力した場合に、その言語 ID を `sourceLanguage` として送ること
- 音声入力中リアルタイム翻訳 request に `sourceLanguage` を含めること
- 翻訳成功時に `translatedText`、`backTranslation`、読み上げボタン、履歴を表示すること
- `/api/translate` が 422 `language_mismatch` を返した場合のエラー表示と状態 reset
- `/api/translate` が 500 を返した場合のエラー表示
- 手入力再翻訳 flow と再翻訳失敗時の扱い
- `/api/tts` に `ttsText` を送ること
- TTS fetch 中の button disabled、audio `onended` 後の復帰、TTS 失敗後の復帰
- `recording` 中は翻訳カードを隠し、音声入力終了後に表示すること

Frontend の TTS テストでは `Audio`、`URL.createObjectURL`、`URL.revokeObjectURL` を mock します。API 呼び出しは `fetch` mock で検証します。

## 4. テスト対象

現在の実装でテスト対象になっている主な機能は次のとおりです。

| 領域 | 対象 |
| --- | --- |
| Backend API | `/health`、`/api/translate`、`/api/tts` |
| 翻訳 | OpenAI Responses API wrapper、翻訳 prompt、JSON response parse |
| 翻訳方向 | `sourceLanguage` 指定、未指定時の `language_mismatch` |
| 固有名詞保護 | Kagome 抽出、英語自己紹介 pattern、placeholder、retry、復元、`ttsText` |
| バックトランスレーション | 翻訳後の back-translation call、placeholder 検証と retry |
| TTS | OpenAI Audio Speech API wrapper、`audio/mpeg` response、TTS error |
| Frontend 音声 | `SpeechRecognition` / `webkitSpeechRecognition`、国旗ボタン音声入力フロー |
| Frontend API 利用 | `/api/translate`、`/api/tts`、`sourceLanguage`、`language_mismatch` |
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

## 8. 削除された旧テスト

現在の実装では、Backend が音声データを受け取って文字起こしする経路はありません。そのため、この文書では現行の `/api/translate`、`/api/tts`、`SpeechRecognition` に関するテスト項目だけを扱います。

音声のテキスト化は Frontend の `SpeechRecognition` / `webkitSpeechRecognition` が担当します。Backend は音声データではなく、認識済みテキストを `/api/translate` で受け取ります。

## 9. 関連ドキュメント

- [architecture.md](architecture.md)
- [translation-flow.md](translation-flow.md)
- [speech-flow.md](speech-flow.md)
- [proper-noun-protection.md](proper-noun-protection.md)
- [api.md](api.md)
