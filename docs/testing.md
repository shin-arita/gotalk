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
| `frontend/src/messages.test.ts` | 利用者向けの文言の共通の関数（`getLocalizedMessage`）と、12 の文言の7言語の辞書 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、録音、確定翻訳、再翻訳、TTS、読み上げの文字数の上限、状態遷移、エラーの文言を選んだ2つの言語で表示すること |
| `frontend/src/hooks/useAudioSession.test.ts` | 録音のセッションの hook（`createAudioSession`、`useAudioSession`）：録音の成立と失敗、利用者の停止、中断の片付け、古いセッションの callback、冪等な片付け、診断の情報 |
| `frontend/src/pages/InterpreterPage.lifecycle.test.tsx` | 通訳画面の録音のライフサイクル：二重のタップ、中断（`hidden`、`pagehide`、戻る、外れる）、古いセッションと古い問い合わせの結果、読み上げの中断、bfcache から戻ったとき |
| `frontend/src/pages/InterpreterPage.ttsGuard.test.tsx` | `handleSpeak` の守り（`useAudioSession` を差し替えて、`ready` で録音のセッションが残っている状態を作る） |
| `frontend/src/pages/MicTestPage.test.tsx` | 開発用のマイクの確認のページ（`#mic-test`） |
| `frontend/src/experiments.test.ts` | 切り分けの実験のスイッチの指定（`ExperimentConfig`）の読み取りと組み合わせ（[切り分けの実験のスイッチ](#切り分けの実験のスイッチ原因の特定の後に外す)） |
| `frontend/src/hooks/useAudioSession.callLog.test.ts` | スイッチがないとき（と `?exp=` のとき）に、ブラウザの API の呼び出しの順番と回数が、スイッチを入れる前（`782635e`）と同じであること |
| `frontend/src/hooks/useAudioSession.experiments.test.ts` | `useAudioSession` のスイッチごとの動きと、実験の診断の記録 |
| `frontend/src/pages/InterpreterPage.experiments.test.tsx` | 通訳の画面のスイッチ（`norecog`、`nolifecycle`、`trace`）と、診断の表示（「更新」「コピー」） |
| `frontend/src/pages/ExperimentPanel.test.tsx` | 診断の表示の部品（スナップショットの表示、直近の5回分、クリップボードがないときの表示） |
| `frontend/src/pages/LegacyInterpreterPage.test.tsx` | `legacy` の部品。`07f06f0` の `InterpreterPage.test.tsx` を、import だけを変えて残したもの |
| `frontend/src/pages/LegacyInterpreterPage.experiments.test.tsx` | `legacy` の部品の実験の記録と、足していないもの（`useAudioSession`、track の読み取り、listener） |
| `frontend/src/App.test.tsx` | `exp` に `legacy` があるときだけ `LegacyInterpreterPage` を使うこと |

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

録音のライフサイクル（[speech-flow.md](speech-flow.md) の「6. 録音のライフサイクル」）は、次のテストで確かめます。`getUserMedia`、`MediaRecorder`、`SpeechRecognition`、`AudioContext`、`requestAnimationFrame` の代わりは `frontend/src/test/audioMocks.ts` にまとめています。`getUserMedia` と `fetch` は、テストが resolve や reject をするまで終わらず、`MediaRecorder` の `ondataavailable` と `onstop` はテストが起こします。

- `starting` の間にもう一度タップしても、`getUserMedia` は1回だけであること
- `getUserMedia` を待っている間に、`hidden`、`pagehide`、戻る、外れるが起きたら、後から成功した stream の track を `stop()` し、録音を始めないこと
- `getUserMedia` の成功の後に、`MediaRecorder` の作成や `start()` が失敗した場合、audio track がない場合、track が `live` でない場合に、track を `stop()` し、`recording_start_failed` を2つの言語で表示し、`idle` に戻ること。`getUserMedia` の失敗は `microphone_denied` のままであること
- 音量の取得や音声認識が失敗しても、録音は成立し、利用者の停止で Backend に送ること
- 利用者の停止で、最後の `ondataavailable` の後に送ること。track の `stop()` が送るより先であること
- 片付けの順番（[speech-flow.md](speech-flow.md) の 6.4 の「片付けの順番」）。利用者の停止では、`MediaStreamAudioSourceNode` の `disconnect()` と `AudioContext` の `close()` が、`MediaRecorder` の `stop()` より先であること。中断（`hidden`、`pagehide`、戻る、外れる、`error`）と失敗（`MediaRecorder` の `onerror`、`MediaRecorder` が自分で止まった）の片付けでは、track の `stop()` より先であること
- 録音中や `stopping` の間に `hidden` になったら、Backend に送らず、track を `stop()` し、`idle` に戻ること。後から来た `onstop` が何もしないこと。`visible` に戻っても自動でマイクを開かないこと
- 音声認識の `onend` で、止める指示の後や、無効なセッションでは始め直さないこと
- 片付けを2回、3回と続けて呼んでも、例外や二重の `stop()` が出ないこと。`AudioContext` の `close()` の拒否や、音声認識の `stop()` の例外を捨てること
- 利用者の停止の後（`stopping` の間）に中断した場合、`abort` の Promise は、利用者の停止で始めた `AudioContext` の `close()` が終わるまで解決しないこと。`close()` が拒否されても `abort` の Promise は解決し、未処理の拒否が出ないこと。`close()` と `disconnect()` は1回だけであること（KK1）
- 止める指示と音量の取得の片付けの後に音量の取得を始めようとしても、`AudioContext` を作らず、`requestAnimationFrame` も頼まないこと（KK4）。今の画面からは起きない経路なので、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります。その後の `onstop` で track を止め、マイク OFF になること
- 止める指示の後に音声認識を始めようとしても、音声認識の constructor も `start()` も呼ばないこと（KK5）。KK4 と同じく、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります。その後の `onstop` で track を止め、マイク OFF になること
- 録音の途中の `MediaRecorder` の `onerror` で片付けて、`recording_failed` を表示すること（録音の成立の前の失敗は `recording_start_failed` のまま）
- 利用者の停止で `MediaRecorder` がすでに `inactive`（`onstop` が未着）のときは、`onstop` を待ち、最後のデータを含めて送ること。`onstop` が利用者の停止の前に届いていたときは送らないこと
- 利用者の停止で `MediaRecorder` の `stop()` が例外を出したときは、Backend に送らず、track を `stop()` し、`recording_failed` を2つの言語で表示し、`idle` に戻ること。診断のログに `recorder_stop_failed:<name>` が残ること
- 利用者の停止の後、`onstop` が見張りの時間（`RECORDER_STOP_TIMEOUT_MS`、10 秒）届かないと、track を `stop()` し、`recording_failed` を表示し、`idle` に戻ること（`recorder_stop_timeout`）。テストは時間を数字で書かず、定数を参照します。9 秒台で `onstop` が届いた場合は、録音の失敗にならずに送ること。待っている間に中断した場合、古いセッションのタイマーの場合は、タイマーが何もしないこと
- 診断の情報に、`stop()` から `onstop` までの時間（`stopLatencyMs`。`MediaRecorder` がすでに `inactive` のときは、止める指示を記録してから）が残ること。見張りのタイマーで片付けた場合は、`stopTimedOut` と待った時間（`stopWaitedMs`）が残り、後から届いた `onstop` までの時間も残ること
- 録音の途中で track が `ended` になり、`MediaRecorder` が自分で止まると、`recording_failed` を表示して `idle` に戻り、track を `stop()` し、Backend に送らないこと。診断のログに `track_ended` と `recorder_stopped_unexpectedly` が残ること。利用者の停止の後の `ended` と、古いセッションの `ended` では何もしないこと
- `ready` 以外では読み上げを押せないこと。読み上げの途中に `hidden` や `pagehide` になったら、`<audio>` を止めてオブジェクト URL を解放し、`ready` に戻ること。`/api/tts` を待っている間に止めた場合は、後から来た音声を再生しないこと
- 古いセッションの callback（`getUserMedia` の完了、`ondataavailable`、`onstop`、`onerror`、音声認識の `onresult` と `onend`、`requestAnimationFrame`）が新しいセッションを壊さないこと
- `processing` の間に `hidden` になっても状態は `processing` のままで、国旗を押せず、結果が来たら `ready` になること。戻るや `pagehide` のときは問い合わせを止め、後から結果や失敗が来ても画面に反映しないこと
- 止めた問い合わせ1の結果が遅れて戻っても、画面には問い合わせ2の結果だけが出ること
- `handleSpeak` の守りが働いたときに、`unexpected_active_audio_session_before_tts` が診断のログに残り、片付けが終わってから `/api/tts` を呼ぶこと
- bfcache から戻ったとき（`pagehide` と `pageshow` の `persisted: true`）に、`starting`、`recording`、`stopping`、`processing` は `idle` に、`ready` と `speaking` は `ready` に直り、マイクを開かず、問い合わせも送らないこと。`pageshow` のときに画面がまだ `processing` でも、記録した状態に直すこと。`persisted: false` の `pageshow` では何もしないこと。bfcache から戻った後に始めたセッション2が、セッション1の古い callback の影響を受けないこと
- 診断の情報に、録音ごとの数値（`getUserMedia` の時刻、track の状態、録音の大きさ、音量、音声認識の文字数など）が残り、会話の本文が残らないこと

利用者向けの文言を選んだ2つの言語で表示すること（[ui.md](ui.md)）は、次のテストで確かめます。画面のテストの期待する文言は、既定の日本語と英語の組み合わせでは helper `jaEn` で作ります。エラーのときの `console.warn` は、ログを確かめるテスト以外では `beforeEach` で出力を止めています。

- `getLocalizedMessage` が、2つの言語（`ja` と `en`、`th` と `vi` など）の文言を選んだ順に空行をはさんで連結すること、辞書にない言語では英語になること、選んだ言語が1つだけのときはその言語の文言だけ、1つもないときは英語の文言になること（`messages.test.ts`）
- 12 の文言のすべてのキーに、7言語の空でない文言がそろっていること。`recording_start_failed` と `recording_failed` の7言語の文言が決めたとおりであること（日本語だけ句点なし）。読み上げの文言の 500 が `TTS_MAX_CHARS` から作られること。`request_timeout` の英語の文言のアポストロフィが U+2019 であること（`messages.test.ts`）
- 12 の文言のそれぞれが、実際の画面で選んだ2つの言語（主にタイ語とベトナム語。ほかにベトナム語とタイ語の順、韓国語と英語）で表示されること（`InterpreterPage messages in the two selected languages`）
- 対応する文言がない status（502）、ネットワークのエラー（`fetch` の reject）、JSON として読めない応答で汎用のエラーの文言を表示し、`HTTP`、`502`、`Failed to fetch`、Backend の `error` の文字列を表示しないこと
- Frontend の timeout では「うまく翻訳できませんでした」、Backend の 504 では「処理に時間がかかっています」を表示すること
- エラーのとき、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`recording_too_large_before_send`、`TypeError` など）が残り、発話の内容、翻訳の結果、`e.message`、Backend の `error` の文字列が残らないこと（`api.test.ts` と `InterpreterPage.test.tsx`）
- ログの `reason` に入る `code` が `^[a-z0-9_]{1,64}$` に一致しない場合（大文字、空白、65 文字、日本語、改行、空文字）は `invalid` になり、元の文字列がログに出ないこと。一致する場合（`upstream_busy`、許可リストにない `some_new_code`、64 文字）はそのまま出ること。表示の判定は変わらないこと（`api.test.ts`。`/api/tts` は `InterpreterPage.test.tsx`）
- 読み上げで表示する文言がない場合（502、ネットワークのエラー）に、何も表示しないこと

`/api/interpret` の結果表示やエラー処理のテストは、`MediaRecorder` と `navigator.mediaDevices.getUserMedia` を mock し、実際の操作と同じく国旗をタップして録音を開始し、同じ国旗をタップして停止することで `/api/interpret` を呼びます（共通の手順は helper `renderAndInterpret` にまとめています）。これらのテストでは `SpeechRecognition` を mock していないため、`transcript` は送られません。`transcript` の送信は、`SpeechRecognition` を mock した国旗タップのテスト 1 件で検証します。

Frontend の TTS テストでは `Audio`、`URL.createObjectURL`、`URL.revokeObjectURL` を mock します。`navigator.mediaDevices`、`URL.createObjectURL`、`URL.revokeObjectURL`、`Audio` は各テストの前の状態を `beforeEach` で保存し、`afterEach` で元に戻します。`MediaRecorder` と `window.SpeechRecognition` は `afterEach` で削除します。API 呼び出しは `fetch` mock で検証します。

開発用のマイクの確認のページ（`#mic-test`、`MicTestPage.test.tsx`）のテストでは、`getUserMedia`、`MediaRecorder`、`SpeechRecognition`、`navigator.permissions`、`URL.createObjectURL`、`URL.revokeObjectURL`、`HTMLMediaElement` の `play()` と `pause()`、`window.AudioContext`（`decodeAudioData`、`createBufferSource`、`resume`、`close`、`state`、`onstatechange`）を mock し（`URL` の2つは `beforeEach` で保存し、`afterEach` で元に戻します。`window.AudioContext` は `afterEach` で削除します）、次を確かめます。ページの使い方は [development.md](development.md) の「8. 注意点」に書いています。

- `#mic-test` のときだけページを表示し、通常の URL では表示しないこと。上部の説明の文（録音をメモリにだけ持ち、捨てるときの説明と、「AudioContext で再生」の目的と試し方の説明を含む）を表示すること
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
- 再生の開始を待っている間（`play()` の Promise が解決する前）に、次の録音を始めた場合と S6 を押した場合に、`AbortError` の拒否を「再生を止めた（録音を捨てたため）」と出し、「再生の失敗」を出さず、未処理の Promise の拒否が出ないこと。もう一度再生した場合は「再生を止めた（もう一度再生したため）」と出すこと。止めていない `Audio` の本当の失敗は、これまでどおり「再生の失敗 name=…」と出すこと
- 再生が始まった後に、次の録音の開始、S6、`pagehide`、もう一度の再生のそれぞれで止めると、「再生を止めた（理由）（録音の情報）」と止めた後の track の状態を1回ずつだけ出し、未処理の Promise の拒否が出ないこと。開始を待っている間に止めた場合（`AbortError` で拒否される場合と、拒否されずに解決する場合）も1回だけ出すこと。再生が終わった後と、再生に失敗した後に録音を捨てても、「再生を止めた」を出さないこと
- `play()` が解決した後に `Audio` の `error` のイベントが起きると、「再生の失敗 code=…」（分からない場合は `code=不明`）と track の状態を1回だけ出し、その後に録音を捨てても「再生を止めた」を出さないこと。`play()` の拒否と `error` のイベントの両方が起きても（どちらの順番でも）「再生の失敗」を1回だけ出すこと。録音を捨てて止めた後に `error` が届いても「再生の失敗」を出さないこと（再生が始まった後に止めた場合と、開始を待っている間に止めて `AbortError` で拒否される場合）。開始を待っている間の `error` の後に録音を捨てても「再生を止めた」を出さないこと。どの場合も未処理の Promise の拒否が出ないこと
- 再生で、再生の開始と終わり、その前後の track の状態をログに出し、Backend への `fetch` を呼ばず、`localStorage` に書かないこと。再生に失敗した場合に、エラーの `name` と track の状態をログに出し、未処理の Promise の拒否が出ないこと。再生している間に次の録音を始めると、再生を止めること
- 「AudioContext で再生」のボタンは、録音がないとき、テストが動いている間、開始を待っている間は押せないこと
- 「AudioContext で再生」を押すと、録音の `Blob` の `ArrayBuffer` で `decodeAudioData` を呼び、`AudioBufferSourceNode` を `destination` につないで `start()` を呼び、`decodeAudioData` の成功（長さの秒数）、再生の前の track の状態、再生の開始をログに出すこと。`<audio>` の `play()` を呼ばないこと。`onended` で、再生の終わりと track の状態をログに出すこと
- `AudioContext` は2回押しても1つだけ作ること。`suspended` のときは `resume()` を呼び、`interrupted` になった後に押したときも `resume()` を呼ぶこと。`running` のときは `resume()` を呼ばないこと。`state` の変化（`running`、`interrupted`、`closed`）をログに出すこと
- `AudioContext` の作成のログに `sampleRate` と `baseLatency` を出し、`baseLatency` がないブラウザでは `sampleRate` だけを出すこと（II3）
- `decodeAudioData` の失敗（`EncodingError`）と `resume()` の失敗（`NotAllowedError`）を、`name` を付けてログに出し（`decodeAudioData` の失敗には録音の `Blob` の `type` も出し、空なら「（空）」、`audio/mp4` ならそのまま出すこと）、`resume()` に失敗したときは `decodeAudioData` を呼ばず、未処理の Promise の拒否が出ないこと。`decodeAudioData` に失敗した後に録音を捨てても、「再生を止めた」を出さないこと。`AudioContext` がないブラウザでは、対応していないとログに出すこと
- 再生している間に、次の録音の開始、S6、`pagehide`、もう一度押したとき、コンポーネントが外れたときに、`AudioBufferSourceNode` の `stop()` を呼び、「AudioContext 再生を止めた（理由）」と止めた後の track の状態を1回だけ出すこと（コンポーネントが外れたときは、`stop()` と `close()` を呼ぶことと、React の警告が出ないことを確かめます）。`stop()` の後に届く `onended` で「再生の終わり」を出さないこと。`decodeAudioData` を待っている間に S6 を押すと、「開始の前」と付けて止めたことを出し、待った後に再生しないこと
- S6、`pagehide`、コンポーネントが外れたときに `AudioContext` の `close()` を呼び、`close()` したことと `closed` への変化をログに出すこと（コンポーネントが外れたときは、画面のログを読めないため、`close()` を呼ぶことだけを確かめます）。次の録音の開始では `close()` を呼ばずに使い回し、S6 の後に押すと新しく作ること。`AudioContext` を作っていなければ、S6 で `AudioContext` のログを出さないこと
- 押した操作の中で（`fireEvent.click` の直後、`await` の前に）`AudioContext` を作って `resume()`（`suspended` のとき）を呼び、`decodeAudioData` はまだ呼ばないこと（II4）
- `resume()` を待っている間に S6 または `pagehide` で止めた場合と、`arrayBuffer()` を待っている間に S6 で止めた場合に、待った後に `decodeAudioData` と `start()` を呼ばず、「開始の前」と付けて止めたことを1回だけ出すこと。待っている間にもう一度押すと、前の再生を「もう一度再生したため、開始の前」として止め、前の `decodeAudioData` が先に解決しても鳴らさず、新しい再生だけを鳴らすこと。待っている間にコンポーネントが外れると、待った後に `start()` を呼ばず、React の警告と未処理の Promise の拒否が出ないこと（II5）
- `resume()` を待っている間に S6 で止めて `close()` した後に `resume()` が拒否されると、「resume() 失敗」と「再生しない」を出さず、「AudioContext resume() を中止（止めたため、または閉じたため）name=…」を出すこと。止めていないときに `resume()` が遅れて拒否されると、これまでどおり「resume() 失敗」を出すこと（II6）
- `resume()` を待っている間に S6 で止めて閉じた後に `resume()` が解決すると、「resume() 成功」を出さず、「resume() は済んだが、止めたため、または閉じたため再生しない」を1回出し、`decodeAudioData` と `start()` を呼ばないこと。`resume()` を待っている間にもう一度押すと、前の再生の分は「resume() 成功」を出さず（済んだが再生しない行を出し）、新しい再生の分だけ「resume() 成功」を出して1回だけ鳴らすこと。止めていないときに `resume()` が遅れて解決すると、これまでどおり「resume() 成功」を出して再生すること（II10）
- `decodeAudioData` が Promise を返さず `undefined` を返す（古い実装）場合に、「decodeAudioData 失敗（結果がない。古い実装の可能性）」と track の状態を出し、`start()` を呼ばず、未処理の Promise の拒否が出ないこと。`try` の外の予期しない例外（結果の `duration` を読むと例外になる場合）も、「AudioContext 再生の処理で例外 name=…」と出し、未処理の Promise の拒否にしないこと（II7）
- `try` の外の例外の後に、S6、`pagehide`、次の録音の開始、もう一度押したときのそれぞれで、「再生を止めた」を出さず、例外の行は1回だけ（もう一度押したときは、その再生の分を合わせて2回）出すこと（II9）
- `<audio>` の再生と `AudioContext` の再生が、互いに止めないこと
- 「AudioContext で再生」でも、Backend への `fetch` を呼ばず、`localStorage` に書かないこと

### 切り分けの実験のスイッチ（原因の特定の後に外す）

iPhone（Safari と Chrome）で、2回目からの録音が空（Backend のログで `size=5`）になる不具合の原因を切り分けるため、スイッチを1つの PR で入れ、デプロイは1回にして、iPhone でスイッチを切り替えながら試します。原因が分かったら、本番の修正を別の PR で入れ、このスイッチ、診断の表示、`legacy` の部品を外します。外す PR では、次の「外すもの」の一覧を漏れなく扱います。

#### 外すもの（原因が分かった後に、外す PR で扱う）

- 消すファイル
  - `frontend/src/experiments.ts`
  - `frontend/src/hooks/experimentTrace.ts`
  - `frontend/src/pages/ExperimentPanel.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.tsx`
- 消すテストのファイル
  - `frontend/src/experiments.test.ts`
  - `frontend/src/hooks/useAudioSession.callLog.test.ts`（ただし、外した後も「本番の呼び出しの順番」の守りとして残す価値があるかを、外す PR で判断します。残す場合は、`readExperimentConfig` を使う2つ目のテスト（`?exp=` のとき）を外します）
  - `frontend/src/hooks/useAudioSession.experiments.test.ts`
  - `frontend/src/pages/ExperimentPanel.test.tsx`
  - `frontend/src/pages/InterpreterPage.experiments.test.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.test.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.experiments.test.tsx`
  - `frontend/src/App.test.tsx`（`exp` に関わるテストを消した後に残すものがあるかを、外す PR で判断します）
- 戻すもの
  - `frontend/src/hooks/useAudioSession.ts`：`createAudioSession` と `useAudioSession` の `config` の引数、スイッチの分岐（`norecog`、`legacyrecog`、`nometer`、`nodisconnect`、`awaitclose`、`notrackread`、`noendedlistener`、`trace`）、`exp` の記録（`Session.exp`、`expDiag`、`perfNow` と、`if (s.exp)` の行のすべて）、`recordPageEvent`、`markTraceListenerOnly`、`AudioDiagnostics.experiment`、`trace` のための型（`SpeechRecognition` の `onstart`、`onaudiostart`、`onaudioend`）、`experiments` と `experimentTrace` の import。`stop` の後半を分けた `stopRecorder` と `startStopWatchdog` を残すか戻すかは、外す PR で判断します
  - `frontend/src/pages/InterpreterPage.tsx`：`experiment` の props、`experimentRef`、`useAudioSession` に渡す `experiment`、ページの listener の分岐（`trace` の記録、`nolifecycle`、記録だけの listener）と `audioSessionRef`、`ExperimentPanel` とその import
  - `frontend/src/App.tsx`：`readExperimentConfig` で読む `experiment`、`LegacyInterpreterPage` への切り替えとその import、`InterpreterPage` に渡す `experiment`
- ドキュメント
  - `docs/testing.md`：「3. Frontend テスト」のテストファイルの表の、この PR で加えた行（上の「消すテストのファイル」の8つ）と、この節（「切り分けの実験のスイッチ」）そのもの
  - `docs/speech-flow.md`：6.9（診断の情報）の終わりの、実験のスイッチの段落

#### スイッチと診断

- 指定：URL の query の `exp` で指定します（例：`?exp=norecog`、`?exp=nometer,norecog`）。hash は使いません（`#mic-test` などと衝突させないため）。画面を読み込んだときに一度だけ読み取り、途中で URL を変えても反映しません。`?exp=` の空の指定でも、実験のモードになります。名前は小文字で書きます（知らない名前は無視し、診断の表示に出します）
- **スイッチがないとき（URL に `exp` がないとき）の動きは、今の本番と同じです。** ブラウザの API の呼び出しの順番と回数を変えず、診断の表示を描画せず、`performance.now()` を使った実験の記録もしません（`useAudioSession.callLog.test.ts` で確かめています）。各スイッチの分岐は、今のコードをそのまま条件の中に置く形にしています

| 名前 | 動き |
| --- | --- |
| （空。`?exp=`） | 今の本番と同じ動き。passive の診断を出す |
| `legacy` | PR #26 の前（`07f06f0`）の通訳の画面を、別の部品（`LegacyInterpreterPage`）としてそのまま使う。`useAudioSession` は使わない |
| `norecog` | 音声認識を一切作らない（constructor も呼ばない） |
| `legacyrecog` | 音声認識の部分だけ、PR #26 の前の方式にする：`start()` が成功した後に ref に入れ、`onend` では `MediaRecorder` が `recording` なら始め直す（画面の状態は見ない）。`07f06f0` との違いは次のとおりです：`onend` の始め直しは止める指示の前だけ、見る `MediaRecorder` はそのセッションのもの（片付けの後は空）、`start()` の例外は今の版と同じく `recognition_failed` として記録する、`onresult` は今の版のまま。理由は、止めた後に音声認識が残ると実験の結果を汚すため（`awaitclose` と組み合わせると、`close()` を待つ間も `recording` のままになる）で、`07f06f0` では止める指示と `MediaRecorder.stop()` が同じ同期の処理の中にあったので、意味は同じです |
| `nometer` | 音量の取得（`AudioContext`、`createMediaStreamSource`、analyser、`requestAnimationFrame`）を一切使わない。波紋は動かない |
| `nodisconnect` | `sourceNode.disconnect()` を呼ばず、`AudioContext.close()` だけにする（利用者の停止と中断の片付けの両方） |
| `awaitclose` | 利用者の停止で、`AudioContext.close()` の完了を待ってから `MediaRecorder.stop()` を呼ぶ。待っている間に中断されたときは、`stop()` を呼ばずに中断の片付けに任せる。見張りのタイマーは、待つ前に始める |
| `notrackread` | `getAudioTracks()` は呼ぶが、track の `readyState`、`enabled`、`muted` を読まず、`live` でないときの失敗の判定もしない（track がないときの失敗の判定は残す） |
| `noendedlistener` | track に `ended` の listener を付けない |
| `nolifecycle` | 通訳の画面で、`visibilitychange`、`pagehide`、`pageshow` の listener を付けない |
| `trace` | extended の記録を有効にする |

組み合わせ：

- `legacy` は単独です。ほかの名前（`trace` も）と一緒に指定したときは `legacy` だけを使い、ほかは効きません
- `norecog` は `legacyrecog` より優先します
- `nometer` は `nodisconnect` と `awaitclose` より優先します
- `nodisconnect` と `awaitclose` は組み合わせて使えます

診断：

- passive（`exp` があるとき）：新しい listener を足さず、自分のコードの中の時刻と、もともとある出来事の handler の中の値だけを記録します。`getDiagnostics()` の値（`notrackread` のときは track の状態を含めない）、スイッチの指定（`raw`、`requested`、`ignored`、`inactive`、`effective`）、`AudioContext` の作成、`createMediaStreamSource` と `connect`、`disconnect`、`close()` を呼んだ時刻と完了の時刻、`getUserMedia` を呼んだ時刻、`MediaRecorder` の `start()` と `stop()` を呼んだ時刻、`ondataavailable` の時刻と大きさ（回ごと）、`onstop` の時刻、最終の `Blob` の大きさ、音量の最初の値と最初の 0 でない値の時刻、音声認識の `start()` と `stop()` を呼んだ時刻と `onresult`（文字数だけ）、`onerror`（エラーの文字列）、`onend` の時刻です。認識した本文は記録しません
- 時刻は、新しく足すものはすべて `performance.now()` です（`requestAnimationFrame` の timestamp と同じ基準）。既存の診断の時刻（`Date.now()`）は変えず、セッションの開始のときに `Date.now()` と `performance.now()` の組を1つだけ残します
- extended（`trace` のとき）：もともと handler があるもの（track の `ended`、`visibilitychange`、`pagehide`、`pageshow`）は、既存の handler の中で記録します。新しい listener を付けるのは、今の版にない出来事（track の `mute` と `unmute`、`MediaRecorder` の `onstart`、音声認識の `onstart`、`onaudiostart`、`onaudioend`）だけです。`nolifecycle` と一緒のときは、記録のためだけの listener を付け（中断の片付けなどはしない）、`traceListenerOnly: true` を残します。`noendedlistener` と一緒のときは、`ended` を記録せず、`endedNotRecorded` にその旨を残します
- `trace` のときは、ページの出来事（`visibilitychange`、`pagehide`、`pageshow`）の handler の中で `document.visibilityState` を読みます（`trace` を付けないときは、`pagehide` と `pageshow` の handler では読みません。`visibilitychange` の handler は、もともと読んでいます）
- `legacy` のとき：PR #26 の前のコードにもともとある `ondataavailable` と `onstop` の中での値と、`start()` と `stop()` を呼んだ箇所の時刻だけを記録します（`ondataavailable` の回数と大きさ、`onstop` で作る最終の `Blob` の大きさと `type`（`blobType`）、`start()` と `stop()` の時刻）。`MediaRecorder` の property（`mimeType` など）、track の読み取り、track の listener、`AudioContext` の診断、ページの出来事の listener は足していません
- 表示：`exp` があるときだけ、通訳の画面の下に、診断の表示と「更新」「コピー」のボタンを出します。表示は「更新」を押したときだけ変わります（直近の5回分）。「コピー」は、押したときに最新の診断の情報を JSON でクリップボードに写します（写せないときは、選んで写せる欄に出します）。録音中（今の通訳の画面は `starting`、`recording`、`stopping`。`legacy` は `recording` と、録音の確定（`onstop` と翻訳の結果）を待つ `processing`）は押せません。`legacy` は `getUserMedia` を待つ間も `idle` のままなので、その間は押せてしまいます（新しい state を足さないため）。定期的な読み取り、新しい timer、出来事ごとの再描画はしません

#### 実機で試す手順

1. 端末は iPhone の Safari です
2. スイッチを変えるたびに、Safari のアプリを終了して（アプリの切り替え画面で上にスワイプして）開き直します。タブを閉じるだけでは足りないものとします
3. 1つのスイッチで3回話します（1回目は成功、2回目と3回目が空になるかを見ます）。原因に当たったスイッチだけ、5回から10回に増やします
4. 失敗したスイッチの後には、`legacy` をもう一度試します。`legacy` まで失敗し始めたら、Safari のプロセスが汚れたと見て、その後の結果は捨てます
5. 順番
   1. `?exp=`（基準）
   2. `?exp=legacy`
   3. `?exp=norecog`
   4. `?exp=nometer`
   5. `?exp=nometer,norecog`
   6. 枝分かれ：音声認識で直ったときは `legacyrecog`。音量の取得で直ったときは `nodisconnect`、`awaitclose`。どちらでも直らないときは `notrackread`、`noendedlistener`、`nolifecycle`
   7. 詳しく見る必要があるときだけ、当たったスイッチに `trace` を足します
6. 「更新」と「コピー」は、録音していないとき（翻訳の結果が出た後）に押します（`legacy` では、国旗を押してからマイクが開くまでの間も押せてしまうので、その間は押しません）。試した後に「コピー」を押し、JSON を Claude.ai に渡します。Backend のログ（`size=`）もあわせて見ます
7. `legacy` で、停止の後に処理中のまま止まったときは、それ自体を結果として書き留め（何回目の録音か）、Safari のアプリを終了して開き直してから続けます（`legacy` は `07f06f0` のままで、`onstop` を待つ見張りのタイマーがないため、`onstop` が届かないと処理中のままになり、「更新」と「コピー」も押せません）

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
