# Testing

## 1. テスト方針

GoTalk のテストは Backend と Frontend を分けて実行します。

Backend は Go 標準の `go test` で、HTTP handler、OpenAI API 呼び出し wrapper（文字起こし、翻訳、TTS）、言語判定結果の照合、固有名詞保護、バックトランスレーション、API エラーを検証します。外部 API へ実通信しないよう、テストでは OpenAI 用の `http.Client`（`openAIClient`）の `Transport` を mock transport に差し替えます。

Frontend は Vitest、Testing Library、jsdom で、言語選択、国旗ボタンによる録音フロー、`/api/interpret` への送信内容、翻訳結果表示、バックトランスレーション表示、再翻訳、TTS、状態遷移、エラー処理を検証します。

## 2. Backend テスト

Backend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `backend/main_test.go` | `whisperLangMatches`、共通 helper、health、固有名詞抽出補助 |
| `backend/main_handlers_test.go` | `/api/interpret`、`/api/translate`、`/api/tts`、OpenAI 呼び出し、固有名詞保護 |
| `backend/propnoun_test.go` | `validatePlaceholders`、`buildRetryPrompt`、`runProtectedTranslation` |
| `backend/languages_test.go` | 言語の対応表と Frontend の `languages.ts` の一致、言語の検証、クライアントの `label` を使わないこと、`/api/interpret` のフィールドの上限と URL の query の値を使わないこと |
| `backend/limits_test.go` | 入力の上限、`max_output_tokens`、OpenAI の呼び出しの最大回数、OpenAI のエラーの変換、キャンセルと deadline、CORS のヘッダがないこと、HTTP サーバーの設定と graceful shutdown |

実行コマンド:

```bash
cd backend
go test ./...
```

主な検証対象:

- `/health` が JSON で `{"status":"ok"}` を返すこと
- `writeError` が `{"error","code"}` の JSON error response を返すこと
- 応答に `Access-Control-Allow-*` のヘッダが付かず、`/api/*` の `OPTIONS` が 405 になること（`TestNoCORSHeaders`）
- 501 文字のテキストや transcript が 400 `input_too_large`、上限を超える body や音声が 413 `input_too_large` になり、OpenAI を呼ばないこと。JSON の未知のフィールドと 2つ目の値が 400 になること。Frontend が送るフィールドを構造体が受け付けること（`TestInputLimits_*`）
- Responses API のすべての呼び出しに `max_output_tokens: 1024` が付き、`status` が `completed` 以外の応答（`incomplete`、`failed`、`status` がない、空の値、`null` を含む）が、出力の文字列があっても失敗になり、`/api/translate` が 502 `upstream_error` を返し、出力の文字列が応答とログに出ないこと（`TestResponsesAPI_MaxOutputTokensOnEveryCall`、`TestCallOpenAI_IncompleteIsFailure`）
- 500 文字の入力で、Responses API に送る入力全体が 9,000 バイト以下に収まること（`TestResponsesAPI_InputSizeFor500Characters`）。例には、エスケープされる文字、1種類の固有名詞の繰り返しのほか、互いに異なる固有名詞を多く含む入力（「many different proper nouns」。すべての応答でプレースホルダが欠け、欠けたプレースホルダの一覧を含む再試行の入力が最も長くなる場合）を含みます
- 「many different proper nouns」の入力（地名を「と」でつないだ 500 文字以内の文字列）から、つないだ地名がすべて別々の固有名詞として抽出され、その数が 150 以上であること（`TestManyProperNounsText`）
- Backend の言語の対応表が `frontend/src/languages.ts` と一致すること（`TestSupportedLanguagesMatchFrontend`）。書き方の違う要素を黙って読み飛ばさないよう、次の2つでも確かめ、違いがあれば失敗すること
  - `LANGUAGES` の配列のトップレベルの要素の数を数え、決まった形式に一致した件数と比べること。要素の種類（オブジェクト、`{ id, ... }` のような省略記法、`{ ...FR }` や `...OTHER_LANGUAGES` のような spread、識別子だけの要素）にかかわらず数え、文字列とコメントの中の括弧やカンマは数えないこと。形式との照合は、コメントを取り除いた配列の中だけで行い、配列の外に定義した要素や、コメントアウトした要素は数えないこと
  - コメントを取り除いた配列の中で、`id` のキー（引用符なし、または `"`、`'`、バッククォートで囲んだもの）を持つ行が、その行だけで決まった形式に一致すること。一致しない行は、`languages.ts` の中の行番号と、`languages.ts` の中のその行の内容（コメントを含む、元のままの行。配列の開始の行に要素がある場合は、その行全体）を示して失敗すること。配列の外（interface の `id: string` や、配列の外に定義したオブジェクトなど）は確かめないこと
- 配列の要素を数える処理（`arrayLiteral`）が、末尾のカンマ、文字列やコメントの中の括弧とカンマ、入れ子の括弧、spread と省略記法を正しく扱い、配列が見つからない場合や括弧の対応が取れない場合はエラーになること。返す配列の中身から、行コメントとブロックコメントを空白に置き換えて取り除き、改行（行の位置）は保つこと。文字列の中の `//` と `/*` はそのまま残すこと。配列の中身の行と `languages.ts` の中の行番号の対応が正しいこと（`TestArrayLiteral`）
- 対応言語でない `id`、同じ言語の 2 つ、空の `id`、未知のフィールド、選択言語でない `speaker` が 400 になり、OpenAI を呼ばないこと（`TestTranslate_LanguageValidation`、`TestInterpret_LanguageValidation`）
- クライアントが送った長い `label` が OpenAI に送る入力に入らず、Backend の `label` が使われ、入力の大きさが変わらないこと（`TestTranslate_ClientLabelsAreIgnored`、`TestInterpret_ClientLabelsAreIgnored`、`TestResponsesAPI_InputSizeIgnoresClientLabels`）。Frontend が送る7言語のすべての組み合わせで、これまでと同じ prompt になること（`TestTranslate_FrontendLanguagesUnchanged`）
- `/api/interpret` の `audio` 以外のフィールドが上限を超えると 413 になること。URL の query の値は使わず、multipart の body の値だけを使うこと（query の長い `transcript` は無視して body の `transcript` を翻訳する、query にだけある `transcript` や言語は body にない場合と同じ扱いになる）（`TestInterpret_FieldLimits`）
- 経路ごとの OpenAI の呼び出しの回数が最大回数の定数と一致し、それを超えて呼ばないこと（`TestMaxOpenAICalls`）
- OpenAI の支出上限とクレジットの枯渇が 503 `service_unavailable`、それ以外の 429 が 503 `upstream_busy`（`Retry-After` は 60 秒以下だけ渡す）になり、どちらも Backend の中では再試行しないこと（`TestOpenAIErrors_Conversion`、`TestParseRetryAfter`）
- 処理の途中で context をキャンセルすると、それ以降の OpenAI の呼び出しをせず、応答を書かないこと（`TestCancellation_StopsFurtherOpenAICalls`）。deadline に達すると 504 `timeout` を返すこと（`TestDeadline_Returns504`）。deadline の値（55 秒、25 秒、25 秒）と、`/api/interpret` の deadline が nginx の 60 秒より短く、`WriteTimeout` より短いこと（`TestDeadlines`）
- OpenAI の呼び出しが `http.DefaultClient` ではなく `openAIClient` を使い、deadline 付きの context で送られること（`TestOpenAIClient`）
- `http.Server` の timeout の設定と、graceful shutdown で処理中のリクエストを待つこと、待つ時間を超えたら接続を閉じること（`TestNewServer`、`TestRunServer_GracefulShutdown`）
- 入力の上限などで拒否したときのログ（`limit: endpoint=... limit_type=...`）に、発話の内容や音声の内容が出ないこと（`TestLogging_LimitsDoNotLogContent`）
- `extractJSON` が OpenAI response から JSON 部分を取り出すこと
- `whisperLangMatches` が言語名（`japanese` など）と ISO コード（`ja` など）の両方で選択言語と照合できること（`TestWhisperLangMatches`）
- `callWhisper` が `whisper-1` と `gpt-4o-transcribe` の正常系、非 200、invalid JSON、transport error を扱うこと（`TestCallWhisper_*` 5 件）
- `callOpenAI` が transport error、非 200、invalid JSON、空 output、空 content、正常系を扱うこと
- `/api/interpret` が method、API key 未設定、invalid multipart、`audio` なし、`myLanguage` / `theirLanguage` の不正と空 ID、言語判定エラー、判定言語が空、`language_mismatch`、文字起こしエラー、翻訳エラー、`myLanguage` / `theirLanguage` それぞれに一致した場合の正常系を扱うこと
- `/api/interpret` が OpenAI のプレーンテキストの翻訳結果（JSON でない文字列）をそのまま `translatedText` として受け付け、HTTP 200 を返すこと（`TestInterpretHandler_InvalidTranslationJSON`）
- `/api/interpret` の transcript 経路で、翻訳 prompt が speech recognition error の補正や固有名詞の生成を禁止する文言を含むこと（`TestInterpretHandler_TranscriptPath_PromptForbidsSpeechCorrection`）
- `/api/translate`（`en` と `ja` を選択）と `/api/interpret`（`en` から `ja` への翻訳）で、英語の自己紹介に続く名前が placeholder にならず、そのまま OpenAI への翻訳 prompt に含まれること（`TestTranslateHandler_EnglishIntroName`、`TestInterpretHandler_EnglishIntroName`）
- `/api/translate` が method、API key 未設定、invalid JSON、空 text、`languages` 不足、OpenAI error、invalid translation JSON、`language_mismatch`、正常系を扱うこと
- `/api/translate` の翻訳 prompt が speech recognition error や固有名詞の過剰補正を禁止する文言を含むこと
- 固有名詞保護で「博多駅」の「博多」、「有田シン」（姓と短いカタカナの名を 1 つの placeholder にまとめる）、「ドン・キホーテ」が placeholder 化され、翻訳結果と `ttsText` にローマ字で復元されること。「博多駅」の「駅」は placeholder にならず、OpenAI が翻訳します
- placeholder が翻訳時に欠落した場合、1 回 retry して成功または 502 になること
- placeholder がバックトランスレーション時に欠落した場合、retry すること
- 翻訳結果に未知の placeholder が含まれた場合、1 回 retry し、retry で正しい出力になれば成功すること。このとき retry prompt が欠落した placeholder を列挙する文面にならないこと（`TestTranslateHandler_UnknownPlaceholder_RetrySucceeds`）
- retry 後も未知の placeholder が含まれる場合、HTTP 502 `proper_noun_protection_failed` になること（`TestTranslateHandler_UnknownPlaceholder_RetryFails`）
- 入力テキストに `__GT_PROPN_` が含まれる場合、`/api/translate` と `/api/interpret` のどちらも固有名詞保護を使わず、保護なし経路（入力をそのまま翻訳 prompt に含める）で翻訳して HTTP 200 を返すこと（`TestTranslateHandler_InputContainsPlaceholderPrefix`、`TestInterpretHandler_InputContainsPlaceholderPrefix`）
- プレースホルダ化したテキストが検証に通らない入力（`博多GT_PROPN_1__に行く`、`__GT_PROPN博多に行く`、`博多_GT_PROPN_000__に行く`）は、`runProtectedTranslation` が OpenAI を呼ばずに保護なし経路と同じ戻り値を返し、通常の入力（`博多駅はどこですか`）は保護経路で翻訳されること（`TestRunProtectedTranslation_PlaceholderTextFailsValidation`）。`/api/translate` では、これらの入力が保護なし経路で翻訳されて HTTP 200 を返すこと（`TestTranslateHandler_PlaceholderTextFailsValidation`）
- `validatePlaceholders` が、正常、欠落、多すぎる、未知の placeholder（数字以外を含むものを含む）、形式が崩れた placeholder（終端の `__` がないもの、途中に空白が入ったもの）、アンダースコアを共有して連結した placeholder（`__GT_PROPN_000___GT_PROPN_001__`）を失敗と判定し、アンダースコアを共有せずに隣り合った placeholder（`__GT_PROPN_000____GT_PROPN_001__`）を成功と判定すること（`TestValidatePlaceholders`）
- `buildRetryPrompt` が、欠落した placeholder がある場合はそれを列挙したうえで、入力にない placeholder を作らず入力と同じ回数だけ含めるよう指示し、ない場合は placeholder をそのまま保持するよう指示する文面になること（`TestBuildRetryPrompt`）
- 英語自己紹介名の抽出条件と intro pattern 判定
- `/api/tts` が method、API key 未設定、invalid JSON、空 text、OpenAI error、非 200、正常系を扱うこと
- `callOpenAITTS` が正常系、transport error、非 200 を扱うこと

`TestInterpretHandler_` で始まるテスト関数は、`TestInterpretHandler_TranscriptPath_PromptForbidsSpeechCorrection` と `TestInterpretHandler_EnglishIntroName`、`TestInterpretHandler_InputContainsPlaceholderPrefix` を含めて 19 件です。

バックトランスレーションは `/api/interpret` と `/api/translate` の中で翻訳後に別 OpenAI call として実行されます。テストでは mock transport の call count や返却値を使い、言語判定 call、文字起こし call、翻訳 call、バックトランスレーション call を検証します。

## 3. Frontend テスト

Frontend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `frontend/src/languages.test.ts` | 言語定義 |
| `frontend/src/api.test.ts` | API の timeout の値、エラーの `code` ごとの文言のキー（`apiErrorFromResponse`）、エラーの文言のキーとログ（`messageKeyForError`）、読み上げの文字数の判定（`isTooLongForTts`）、`/api/interpret` に送る録音の大きさの上限（`MAX_INTERPRET_AUDIO_BYTES`） |
| `frontend/src/messages.test.ts` | 利用者向けの文言の共通の関数（`getLocalizedMessage`）と、10 の文言の7言語の辞書 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、録音、確定翻訳、再翻訳、TTS、読み上げの文字数の上限、状態遷移、エラーの文言を選んだ2つの言語で表示すること |
| `frontend/src/pages/MicTestPage.test.tsx` | 開発用のマイクの確認のページ（`#mic-test`） |

実行コマンド:

```bash
cd frontend
npm test
```

主な検証対象:

- `LANGUAGES` が 7 件で、各言語の `id`、`speechCode`、`label` が定義されていること
- 言語 ID が一意であること
- 言語選択画面が全言語カードとアプリ名を表示し、下部のマイクボタンを表示しないこと
- 選択中の言語カードは `aria-pressed="true"`、未選択の言語カードは `aria-pressed="false"` になること
- 言語カードの選択、解除、3 言語目を追加しない制御
- 2 言語目選択時の navigation callback（`onSelectionChange` の後に `onNavigate` を呼ぶこと、1 言語目の選択や選択解除では呼ばないこと）
- 言語選択画面を unmount しても例外が発生しないこと
- 国旗ボタンが選択言語ごとに表示されること
- 選択言語が 2 未満の場合は国旗バーを表示しないこと
- 通訳画面に下部のマイクボタンがないこと
- `MediaRecorder` と `getUserMedia` の mock を使った、国旗タップによる録音開始・停止
- 録音中の反対側の国旗の disabled、録音完了後の再有効化
- 同じ国旗の再タップで録音を停止し、`/api/interpret` を呼ぶこと
- 左右どちらの国旗で録音したかに応じて、その言語を `speaker` と `myLanguage`、もう一方を `theirLanguage` として送ること
- `getUserMedia` が失敗した場合にマイクアクセスのエラーを表示すること
- `SpeechRecognition` の mock で認識結果を返した場合に、その文字列を `transcript` として `/api/interpret` に送り、レスポンスの `text` ではなく認識結果を原文として表示し続けること
- `/api/interpret` が 422 `language_mismatch` を返した場合に、選択言語ごとの言語不明メッセージを選んだ順に空行をはさんで表示し、翻訳文を空にして `idle` に戻すこと（3 件）
- 確定翻訳の成功時に `translatedText`、`backTranslation`、読み上げボタン、履歴を表示すること
- 履歴は展開ボタンなしで全件を表示すること
- `/api/interpret` が 500 を返した場合に、汎用のエラーの文言を表示すること
- 再翻訳で `/api/translate` が 422 `language_mismatch` を返した場合のエラー表示
- 再翻訳で `/api/translate` が 500 を返した場合に汎用のエラーの文言を表示することと、直前の翻訳文と読み上げボタンが残ること
- `/api/tts` に `ttsText` を送ること
- TTS fetch 中の button disabled、audio `onended` 後の復帰、TTS 失敗後の復帰
- `recording` 中は翻訳カードを隠し、録音終了後に表示すること
- すべての `fetch`（`/api/interpret`、リアルタイム翻訳と再翻訳の `/api/translate`、`/api/tts`）に `AbortSignal` が渡され、Backend が受け付けるフィールドだけを送ること
- `/api/interpret` は 65 秒、`/api/translate` と `/api/tts` は 30 秒で `fetch` が abort されること。`/api/interpret` と再翻訳の `/api/translate` の abort では「うまく翻訳できませんでした」の文言を表示すること
- リアルタイム翻訳の `fetch` が、認識テキストが変わったときと録音を止めたときに abort されること
- エラーの応答の `code`（`input_too_large`、`service_unavailable`、`upstream_busy`、`timeout`）に応じた表示をし、それ以外の `code` では OpenAI の内部のエラーコードや status を表示せずに汎用のエラーの文言を表示すること。`/api/tts` のエラーは、表示のない `code` では何も表示しないこと
- `isTooLongForTts` が、Backend の `textTooLong` と同じく、前後の空白を除かずに Unicode のコードポイント単位で数えること（500 文字は可、501 文字は不可。サロゲートペアと対になっていないサロゲートは 1 文字）
- 500 文字ちょうどの翻訳の結果では `/api/tts` を呼ぶこと。500 文字を超える翻訳の結果では `/api/tts` を呼ばずに読み上げ用の文言を表示し、翻訳の結果の全文は表示されたままで、読み上げボタンも押せること。前後の空白と、サロゲートペアの文字（絵文字）の数え方が Backend と同じであること
- `/api/tts` が `input_too_large` を返したときに読み上げ用の文言を表示すること。`/api/translate` の `input_too_large` は、これまでの文言のままであること
- `/api/interpret` が 413 を返したときに、本文が nginx の HTML でも、Backend の JSON（`input_too_large`）でも、空でも「録音が長すぎます。短く区切って話してください。」を表示すること。413 以外のエラー（502 `upstream_error` など）は、汎用のエラーの文言であること
- 録音の Blob が 1,032,192 バイトちょうどなら `/api/interpret` を呼び、1 バイトでも超えたら呼ばずに同じ文言を表示すること
- `/api/translate` と `/api/tts` の 413 の表示は変わらないこと
- 録音が長すぎる文言を表示した後の画面の状態（録音していない、両方の国旗が押せる、読み上げボタンがない、翻訳カードが処理中でない、履歴が増えない）が、`/api/interpret` のほかのエラー（502）のときと同じであること

利用者向けの文言を選んだ2つの言語で表示すること（[ui.md](ui.md)）は、次のテストで確かめます。画面のテストの期待する文言は、既定の日本語と英語の組み合わせでは helper `jaEn` で作ります。エラーのときの `console.warn` は、ログを確かめるテスト以外では `beforeEach` で出力を止めています。

- `getLocalizedMessage` が、2つの言語（`ja` と `en`、`th` と `vi` など）の文言を選んだ順に空行をはさんで連結すること、辞書にない言語では英語になること、選んだ言語が1つだけのときはその言語の文言だけ、1つもないときは英語の文言になること（`messages.test.ts`）
- 10 の文言のすべてのキーに、7言語の空でない文言がそろっていること。読み上げの文言の 500 が `TTS_MAX_CHARS` から作られること。`request_timeout` の英語の文言のアポストロフィが U+2019 であること（`messages.test.ts`）
- 10 の文言のそれぞれが、実際の画面で選んだ2つの言語（主にタイ語とベトナム語。ほかにベトナム語とタイ語の順、韓国語と英語）で表示されること（`InterpreterPage messages in the two selected languages`）
- 対応する文言がない status（502）、ネットワークのエラー（`fetch` の reject）、JSON として読めない応答で汎用のエラーの文言を表示し、`HTTP`、`502`、`Failed to fetch`、Backend の `error` の文字列を表示しないこと
- Frontend の timeout では「うまく翻訳できませんでした」、Backend の 504 では「処理に時間がかかっています」を表示すること
- エラーのとき、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`recording_too_large_before_send`、`TypeError` など）が残り、発話の内容、翻訳の結果、`e.message`、Backend の `error` の文字列が残らないこと（`api.test.ts` と `InterpreterPage.test.tsx`）
- ログの `reason` に入る `code` が `^[a-z0-9_]{1,64}$` に一致しない場合（大文字、空白、65 文字、日本語、改行、空文字）は `invalid` になり、元の文字列がログに出ないこと。一致する場合（`upstream_busy`、許可リストにない `some_new_code`、64 文字）はそのまま出ること。表示の判定は変わらないこと（`api.test.ts`。`/api/tts` は `InterpreterPage.test.tsx`）
- 読み上げで表示する文言がない場合（502、ネットワークのエラー）に、何も表示しないこと

`/api/interpret` の結果表示やエラー処理のテストは、`MediaRecorder` と `navigator.mediaDevices.getUserMedia` を mock し、実際の操作と同じく国旗をタップして録音を開始し、同じ国旗をタップして停止することで `/api/interpret` を呼びます（共通の手順は helper `renderAndInterpret` にまとめています）。これらのテストでは `SpeechRecognition` を mock していないため、`transcript` は送られません。`transcript` の送信は、`SpeechRecognition` を mock した国旗タップのテスト 1 件で検証します。

Frontend の TTS テストでは `Audio`、`URL.createObjectURL`、`URL.revokeObjectURL` を mock します。`navigator.mediaDevices`、`URL.createObjectURL`、`URL.revokeObjectURL`、`Audio` は各テストの前の状態を `beforeEach` で保存し、`afterEach` で元に戻します。`MediaRecorder` と `window.SpeechRecognition` は `afterEach` で削除します。API 呼び出しは `fetch` mock で検証します。

開発用のマイクの確認のページ（`#mic-test`、`MicTestPage.test.tsx`）のテストでは、`getUserMedia`、`MediaRecorder`、`SpeechRecognition`、`navigator.permissions`、`URL.createObjectURL`、`URL.revokeObjectURL`、`HTMLMediaElement` の `play()` と `pause()` を mock し（`URL` の2つは `beforeEach` で保存し、`afterEach` で元に戻します）、次を確かめます。ページの使い方は [development.md](development.md) の「8. 注意点」に書いています。

- `#mic-test` のときだけページを表示し、通常の URL では表示しないこと。上部の説明の文（録音をメモリにだけ持ち、捨てるときの説明を含む）を表示すること
- S1 では開始のたびに `getUserMedia` を呼び、停止で track の `stop()` を呼び、閉じる前の track の状態と閉じたことをログに出すこと
- S2 では `getUserMedia` を最初の1回だけ呼び、開始と停止で `track.enabled` を true と false に切り替え、track の `stop()` を呼ばないこと
- S7 では `getUserMedia` を最初の1回だけ呼び、`track.enabled` が true のままであること
- S3 では `getUserMedia` を最初の1回だけ呼び、`track.enabled` が true のままで、`MediaRecorder` を作らず、停止で track を閉じないこと
- S4 では `getUserMedia` と `MediaRecorder` を呼ばずに、音声認識の `start()` と `stop()` を呼ぶこと（設定は `ja-JP`、`continuous`、`interimResults`）。音声認識がないブラウザでは、S3、S4、S5 で対応していないとログに出すこと
- S5 では `getUserMedia` を最初の1回だけ呼び、開始と停止で `track.enabled` を true と false に切り替え、録音と音声認識の両方を始めて止めること
- track が `ended` になった後に S2 や S3 を始めると、古い track の `stop()` を呼んでマイクを開き直し、そのことと、`ended` がどのテストの何回目の開始の後に起きたかをログに出すこと
- `MediaRecorder` の作成や `start()`、音声認識の `start()` が例外になる場合に、失敗をログに出し、開いたマイクと録音を閉じて、テストが始まっていない状態に戻ること。もう一度始めても前の track が残らないこと。未処理の Promise の拒否が出ないこと（Node の `unhandledRejection` で確かめます）
- `getUserMedia` を待っている間に `pagehide` やコンポーネントが外れて閉じた場合に、後から成功した track の `stop()` を呼ぶこと。待っている間は S6 を含むほかのボタンを押せないこと。コンポーネントが外れた後も、React の警告（`console.error`）や未処理の Promise の拒否が出ないこと
- S2 と S1 の `getUserMedia` を待っている間に `pagehide` が起きた場合に、「開始をやめる（開始を待っている間に閉じられたため）」を出し、「開始に失敗したため、すべて閉じる」を出さず、閉じる処理が `pagehide` の1回だけであること。閉じられていない本当の失敗（`MediaRecorder` の作成の例外）では、これまでどおり「開始に失敗したため、すべて閉じる」を出すこと。別のテストからの切り替え（S2 の後の S3、動いている S7 からの S1）では「開始をやめる」を出さず、新しいテストが始まること
- S6 ではすべての track の `stop()` と音声認識の `stop()` を呼び、その後の S2 でマイクを開き直すこと。別のテストを始めるときは前のテストのマイクを閉じ、音声認識が動いている場合（S4 など）は音声認識の `stop()` を呼ぶこと
- `navigator.permissions.query` が例外になる場合に `unsupported` と表示すること
- Backend への `fetch` を呼ばないこと
- 音声認識の結果の文字列を画面に表示せず、文字数だけを表示すること
- `pagehide` とコンポーネントが外れたときに、マイク、録音、音声認識を閉じること
- track の `mute` と `unmute` で、テストの番号と開始の回数を入れたログ（「track[0] mute（S3 2回目の開始の後）」）を出すこと。track の状態のログに `muted` を出すこと
- 音声認識の `onsoundstart`、`onsoundend`、`onspeechstart`、`onspeechend`、`onnomatch` をログに出すこと
- 録音していないとき（最初と、S3、S4 だけを試した後）と、録音している間は、「直前の録音を再生」のボタンを押せないこと
- S2 で録音して停止すると、ボタンを押せるようになり、テストの番号、回数、バイト数を表示し、録音したデータの `Blob` から object URL を作ること。S1、S5、S7 でも押せるようになること
- 次の録音の開始、S6、`pagehide`、コンポーネントが外れたときに直前の録音を捨て、`URL.revokeObjectURL` を呼ぶこと。録音しないテスト（S3）に切り替えても捨てないこと。録音している間に S6 を押し、`MediaRecorder` の `stop` のイベントが後から届いた場合に、その録音を持たないこと
- S5 で録音を始めた後に音声認識の `start()` や作成が失敗した場合に、`MediaRecorder` の `stop` のイベントがすぐに届いても遅れて届いても、その録音を持たず（`URL.createObjectURL` を呼ばず）、再生のボタンを押せないこと。その前に持っていた録音は「次の録音の開始」として捨てること。録音を始める前に失敗した開始（S2 の録音中に切り替えた S7 の `getUserMedia` の失敗）では、止めた S2 の録音を持つこと。S5 の `getUserMedia` を待っている間に `pagehide` で閉じた場合も、録音を持たないこと
- テストが動いている間（S5 で録音した後に始めた S3）と、`getUserMedia` を待っている間は、再生のボタンを押せず、「（テストを止めてから再生できます）」を表示すること。テストを止めると押せるようになること
- GG1 で開き直した track と、S6 の後に開き直した track でも、`mute` と `unmute` を、テストの番号と正しい開始の回数でログに出すこと。2回目の開始で作った音声認識の `onsoundstart` と `onspeechstart` をログに出すこと
- 再生で、再生の開始と終わり、その前後の track の状態をログに出し、Backend への `fetch` を呼ばず、`localStorage` に書かないこと。再生に失敗した場合に、エラーの `name` と track の状態をログに出し、未処理の Promise の拒否が出ないこと。再生している間に次の録音を始めると、再生を止めること

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
| 費用の上限とキャンセル | 入力の上限、`max_output_tokens`、OpenAI の呼び出しの最大回数、OpenAI のエラーの変換、deadline とキャンセル、Frontend の timeout |
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

Docker Compose には Backend 開発用の `backend-dev` service があります。`./backend` を `/app` に mount し、Go command を実行できます。`backend-dev` は `profiles: ["dev"]` に属していますが、`docker compose run --rm backend-dev ...` は `--profile` を付けずに実行できます。

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

coverage は Frontend だけを計測しています。`npm run test:coverage`（`vitest run --coverage`）が `@vitest/coverage-v8` で計測し、`frontend/vitest.config.ts` ではしきい値を設定していません。計測対象は `src/**/*.{ts,tsx}` で、`src/main.tsx`、`src/App.tsx`、`src/pages/TtsTestPage.tsx` は計測対象から除外しています。Backend は CI で `go test ./...` を実行するだけで、coverage は計測していません。

## 8. 関連ドキュメント

- [architecture.md](architecture.md)
- [translation-flow.md](translation-flow.md)
- [speech-flow.md](speech-flow.md)
- [proper-noun-protection.md](proper-noun-protection.md)
- [api.md](api.md)
- [ui.md](ui.md)
