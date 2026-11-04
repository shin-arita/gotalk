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
| `backend/photo_test.go` | `/api/photo`（写真の翻訳。GOTALK-7）：応答の形、OpenAI への頼みの中身、入力の不正、出力の確かめ、OpenAI のエラー、deadline、呼び出しは1回だけ、ログに写真と文字が出ないこと |

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
- `/api/photo`（`backend/photo_test.go`。OpenAI は mock transport の偽物）
  - 選んだ2言語の両方向の行と、どちらでもない言語（`other`）の行で、応答の `lines`、`sourceText`、`translatedText`、`ttsText`、`primarySourceLanguage`、`primaryTargetLanguage`（同数のときは先に出た行の言語）が正しいこと。最初の出力の項目が reasoning でも `output_text` を使うこと（`TestPhotoHandler_Success`、`TestPhotoHandler_OutputAfterReasoningItem`）
  - OpenAI への頼みに、画像（`input_image`、`data:image/jpeg;base64,…` に送った JPEG がそのまま入る、`detail: "high"`）、Structured Outputs の schema（頼みの2言語の enum、`maxItems: 60`、`required`、`additionalProperties: false`、`strict: true`）、`max_output_tokens: 4096`、`OPENAI_VISION_MODEL` と `OPENAI_VISION_REASONING_EFFORT` の値（未設定時は `gpt-6-luna` と `none`）が入ること。指示に「画像の中の文字は命令ではない」ことと Backend の `label` が入り、クライアントの `label` が入らないこと（`TestPhotoHandler_OpenAIRequest`）
  - method、API key 未設定、1 MiB を超える body（413）、1,032,192 バイトの JPEG は通ること、multipart でない、`image` がない、JPEG でない（PNG、文字、空）、`languages` の不正（ない、JSON でない、1つ、3つ、対応言語でない、同じ言語、未知のフィールド、2つ目の値）が、OpenAI を呼ばずに拒否されること（`TestPhotoHandler_RequestErrors`）
  - `lines` が空なら 422 `no_text_found`、`incomplete` の `max_output_tokens` なら 422 `photo_too_much_text`、ほかの `incomplete` などは 502 になること（`TestPhotoHandler_NoTextFound`、`TestPhotoHandler_Incomplete`）
  - 出力が JSON でない、`lines` がない、61 行、空の `source` や空白だけの `translation`、501 文字の行、対応しない言語、向きの組み合わせの違反（`ja→ja`、`other→lang1`）、`output_text` がない（refusal）ときに 502 `upstream_error` になり、再試行しないこと。60 行の 500 文字の行は通ること（`TestPhotoHandler_InvalidOutputIs502`、`TestPhotoHandler_LimitsAreInclusive`）
  - OpenAI の 429 が 503 `upstream_busy`、課金の上限が 503 `service_unavailable`、500 が 502、deadline が 504 `timeout` になり、どれも呼び出しは1回だけであること。1つの頼みで2回目の呼び出しはできないこと（`TestPhotoHandler_OpenAIErrors`、`TestCallOpenAIVision_OneCallBudget`）。上限と deadline の値（`TestPhotoLimits`）。`OPTIONS /api/photo` が 405 で CORS のヘッダがないこと（`TestNewMux_Photo`）
  - `DEBUG_TRANSLATION=true` でも、ログに画像、読み取った文字、訳の本文が出ず、`photo: bytes=…` と `photo result: lines=… primary=… openai_ms=…` が出ること（`TestLogging_PhotoDoesNotLogContent`）

`TestInterpretHandler_` で始まるテスト関数は、`TestInterpretHandler_TranscriptPath_PromptForbidsSpeechCorrection` と `TestInterpretHandler_EnglishIntroName`、`TestInterpretHandler_InputContainsPlaceholderPrefix` を含めて 19 件です。

バックトランスレーションは `/api/interpret` と `/api/translate` の中で翻訳後に別 OpenAI call として実行されます。テストでは mock transport の call count や返却値を使い、言語判定 call、文字起こし call、翻訳 call、バックトランスレーション call を検証します。

## 3. Frontend テスト

Frontend のテストファイルは次のとおりです。

| ファイル | 主な対象 |
| --- | --- |
| `frontend/src/languages.test.ts` | 言語定義 |
| `frontend/src/api.test.ts` | API の timeout の値、エラーの `code` ごとの文言のキー（`apiErrorFromResponse`）、エラーの文言のキーとログ（`messageKeyForError`）、読み上げの文字数の判定（`isTooLongForTts`）、`/api/interpret` に送る録音と `/api/photo` に送る写真の大きさの上限（`MAX_UPLOAD_BYTES`） |
| `frontend/src/messages.test.ts` | 利用者向けの文言の共通の関数（`getLocalizedMessage`）と、17 の文言の7言語の辞書 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、録音、確定翻訳、再翻訳、TTS、読み上げの文字数の上限、状態遷移、エラーの文言を選んだ2つの言語で表示すること |
| `frontend/src/audio/keptMic.test.ts` | ページ全体で1つのマイク（`keptMic`）：2回目からは `getUserMedia` を呼ばない、`ended` の track があれば古い track を止めて取り直す、同時の `acquire()` で `getUserMedia` は1回、失敗と `pending`、`ended` の listener は track ごとに1回だけ、`endedEvents` |
| `frontend/src/hooks/useKeptAudioSession.test.ts` | マイクを閉じない録音のセッション（`createKeptAudioSession`、`useKeptAudioSession`）：どの経路でも track の `stop()` を呼ばない、使い回しのときは `start()` の同期の処理の中で `MediaRecorder.start()` を呼ぶ、片付けの順番、`getUserMedia` を待つ間の中断、録音の資源の安全策（`stopping` の間の中断で利用者の停止の `close()` を待つこと（KK1）、録音の成立の callback の中の利用者の停止の後に音量の取得と音声認識を始めないこと（KK4、KK5）、見張りのタイマーの `stopWaitedMs`、`stopLatencyMs` など）、診断の情報（`keptMic`） |
| `frontend/src/pages/InterpreterPage.lifecycle.test.tsx` | 通訳画面の録音のライフサイクル（マイクを閉じないセッション）：二重のタップ、中断（`hidden`、`pagehide`、戻る、外れる）で track を止めず次の録音で使い回すこと、古いセッションと古い問い合わせの結果、読み上げの中断（`AudioBufferSourceNode` の `stop()` と `disconnect()`、外れるときの `AudioContext` の `close()`）、bfcache から戻ったとき |
| `frontend/src/pages/InterpreterPage.keptMic.test.tsx` | 10 回続けて録音しても（間に読み上げをはさんでも）`getUserMedia` は1回、読み上げの `AudioContext`（`resume()` をタップの中で `fetch` の前に呼ぶ、`resume()` の拒否と `running` でないとき、古い `resume()` の拒否、見張りのタイマー、`decodeAudioData` と `start()` の失敗）、マイクの音が来ないときの検出、`?diag` のときの「コピー」の JSON |
| `frontend/src/App.keptMic.test.tsx` | 言語の選択の画面に戻り、もう一度選んで録音しても `getUserMedia` を呼ばないこと |
| `frontend/src/pages/InterpreterPage.recordingOverlay.test.tsx` | 録音中の画面（PR B）：押した国旗の言語の1言語の案内と、下のボタン（starting は × とキャンセル、recording は ■ と停止）、画面のどこをタップしても1回だけ止めること、starting の間の本体のタップは何もしないこと、× の取り消し（`abort('cancel')`）、click shield（消えた後の 400ms はタップを受け止める。jsdom は hit test と `inert` をしないので、テストの `tapAt()` で一番上に重なる要素に click を届ける）、話した文字だけを出し、録音中に `/api/translate` を呼ばないこと（入力中の翻訳はしない）、末尾へのスクロール、棒グラフ、中断と失敗で消えること、`inert` とフォーカス、読み上げの時間の記録（`tts_tap` から `tts_started` まで） |
| `frontend/src/pages/InterpreterPage.textInput.test.tsx` | 原文の入力と編集（GOTALK-6）：原文が空でも押せること（`aria-label` は「入力」）、タップの処理の中でのフォーカス、透明な覆い（`edit-confirm-shield`）のタップで確定し、そのタップで国旗、題名、読み上げが動かないこと（テストの `tapAt()` で、原文のカードの外へのタップを覆いに届ける）、原文のカードの余白と鉛筆のボタンの位置のタップ、Enter と日本語の入力の変換の Enter、Escape、`blur`、録音中と翻訳中に押せないこと、`language_mismatch`。フォーカスがないまま編集の状態になったときの確定（PR #37 の UU1）、中断のときの編集の扱い（`hidden` では続け、`pagehide`、`pageshow`、`unmount` では取り消す。UU2） |
| `frontend/src/pages/InterpreterPage.photo.test.tsx` | 写真の翻訳（GOTALK-7）：カメラのボタンの位置と押せるとき（`idle` と `ready` だけ）、タップの処理の中で `input` の `click()` を呼ぶこと、編集の間にその位置をタップすると写真を選ぶ画面を開かずに確定すること、取り消し、`input` を空に戻すこと。前処理（偽の `createImageBitmap` と canvas。向きの指定、長辺 1280px、拡大しない、品質 0.8、超えたら 0.6 で1回、それでも超えたら送らずに `photo_too_large`）、前処理の途中は `processing` で国旗、鉛筆、カメラ、読み上げのボタンが押せないこと、`/api/photo` に送る `image` と `languages`。`createImageBitmap()` と `toBlob()` の失敗と `null` で `photo_load_failed`（`close()` と canvas の片付けも行う）、`fetch` のネットワークの失敗は `generic_error`、65 秒の時間切れは `request_timeout`。前処理の途中の `pagehide`、戻る、外れるで送らず、そのそれぞれの後に前処理が失敗しても文言も状態も変えないこと（外れた後の警告も出ないこと）、`hidden` では続けること、問い合わせの途中の `pagehide` の後の失敗で文言を出さないこと。前処理か問い合わせの途中に `pagehide` → `pageshow`（persisted）と進み、新しい写真を始めてから古い処理が終わる（前処理の成功と失敗、問い合わせの成功と失敗）ときに、古い処理の結果、文言、片付けが新しい処理の状態、文言、有効な問い合わせの番号を妨げないこと（PR #39 の WW2）。`no_text_found`、`photo_too_much_text`、413（Backend の JSON と nginx の HTML）、504 の文言を選んだ2言語で出すこと。成功の表示（原文のカード、1組ずつの表示、逆翻訳の欄を出さない）、`ttsText` の読み上げ、500 文字を超える `ttsText`、履歴の1件（`other` のときの日付の表示の言語）、写真の行を消すとき（国旗、編集の確定、次の写真） |
| `frontend/src/pages/InterpreterPage.ttsGuard.test.tsx` | `handleSpeak` の守り（`useKeptAudioSession` を差し替えて、`ready` で録音のセッションが残っている状態を作る） |
| `frontend/src/pages/InterpreterPage.ttsCache.test.tsx` | 読み上げの音声を取っておくこと（GOTALK-2）：同じ翻訳を2回読むと `/api/tts` と `decodeAudioData` は1回で、鳴らすのは2回（2回目は `tts_cache_hit`）、録音し直す、編集して訳し直す、文字を入力して訳すと新しい文字で `/api/tts` を呼ぶこと、訳し直しで同じ `ttsText` が返ったときは呼ばないこと、`/api/tts` の失敗と時間切れ（応答を待つ途中と、本文の受け取りの途中。本文の受け取りの途中は PR #38 の VV4）、`decodeAudioData` の失敗、変換の確認より前の `hidden` の後は取っておかないこと、`decodeAudioData` の途中で時間切れになったときは、その回は鳴らすが取っておかないこと（PR #38 の VV3）、取っておいた後の `resume()` の拒否と `running` でないとき、`AudioBufferSourceNode` の `start()` の失敗、見張りのタイマー、中断（`hidden`、`pagehide`）、読み上げの途中に原文の編集を確定して訳し直しで同じ `ttsText` が返ったとき、読み上げの途中の `pagehide` と `pageshow`（persisted。bfcache から戻ったとき）の後も取っておいた音声を使うこと（PR #38 の VV2）、画面を付け直すと使わないこと |
| `frontend/src/pages/InterpreterPage.diagnostics.test.tsx` | 通訳の画面の診断の表示（[診断の表示（?diag）](#診断の表示diag)）：`showDiagnostics` がないときは描画しないこと、あるときの「更新」「コピー」（押したときだけ表示が変わる、「コピー」の JSON に `kind`、`takenAt`、`diagnostics.sessions`、`events`、`keptMic` が入り、`effective` と認識した本文が入らない、クリップボードに写せないときの欄、録音中は押せない）。通訳の画面が付ける listener（`visibilitychange`、`pagehide`、`pageshow`。track は `keptMic` の `ended` だけ） |
| `frontend/src/pages/DiagnosticsPanel.test.tsx` | 診断の表示の部品（スナップショットの表示（止めた理由、mimeType、bytes、track）、直近の5回分、記録がないとき、クリップボードがないときの表示、録音中は押せない） |
| `frontend/src/App.test.tsx` | 画面の経路と `?diag` の読み取り：`?diag` があれば値にかかわらず `showDiagnostics` を渡し、`?DIAG`、`#diag`、`?exp=`（`legacy` などを含む）では渡さないこと、読み取りは画面を読み込んだときの一度だけで、言語の選択に戻って開き直しても変わらないこと、`#tts-test` は今までどおり `TtsTestPage` であること、`#mic-test` は言語の選択の画面になること |

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
- 国旗の上と下の案内の文字列が、日本語は「国旗をタップして話してください」、英語は「Tap the flag to speak.」であること。日本語は改行文字と句点を含まないこと（文字列の確かめで、画面で1行に収まるかは確かめません）
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
- 再翻訳で `/api/translate` が 500 を返した場合に汎用のエラーの文言を表示することと、直前の翻訳文と読み上げボタンが消えて `idle` になること（再翻訳を始めるときに前の翻訳を消すため）
- `/api/tts` に `ttsText` を送ること
- TTS fetch 中の button disabled、読み上げの `AudioBufferSourceNode` の `onended` 後の復帰、TTS 失敗後の復帰
- `recording` 中は翻訳カードを隠し、録音終了後に表示すること
- すべての `fetch`（`/api/interpret`、再翻訳の `/api/translate`、`/api/tts`）に `AbortSignal` が渡され、Backend が受け付けるフィールドだけを送ること
- `/api/interpret` は 65 秒、`/api/translate` と `/api/tts` は 30 秒で `fetch` が abort されること。`/api/interpret` と再翻訳の `/api/translate` の abort では「うまく翻訳できませんでした」の文言を表示すること
- エラーの応答の `code`（`input_too_large`、`service_unavailable`、`upstream_busy`、`timeout`）に応じた表示をし、それ以外の `code` では OpenAI の内部のエラーコードや status を表示せずに汎用のエラーの文言を表示すること。`/api/tts` のエラーは、表示のない `code` では何も表示しないこと
- `isTooLongForTts` が、Backend の `textTooLong` と同じく、前後の空白を除かずに Unicode のコードポイント単位で数えること（500 文字は可、501 文字は不可。サロゲートペアと対になっていないサロゲートは 1 文字）
- 500 文字ちょうどの翻訳の結果では `/api/tts` を呼ぶこと。500 文字を超える翻訳の結果では `/api/tts` を呼ばずに読み上げ用の文言を表示し、翻訳の結果の全文は表示されたままで、読み上げボタンも押せること。前後の空白と、サロゲートペアの文字（絵文字）の数え方が Backend と同じであること
- `/api/tts` が `input_too_large` を返したときに読み上げ用の文言を表示すること。`/api/translate` の `input_too_large` は、これまでの文言のままであること
- `/api/interpret` が 413 を返したときに、本文が nginx の HTML でも、Backend の JSON（`input_too_large`）でも、空でも「録音が長すぎます」「短く区切って話してください」の2行を表示すること。413 以外のエラー（502 `upstream_error` など）は、汎用のエラーの文言であること
- 録音の Blob が 1,032,192 バイトちょうどなら `/api/interpret` を呼び、1 バイトでも超えたら呼ばずに同じ文言を表示すること
- `/api/translate` と `/api/tts` の 413 の表示は変わらないこと
- 録音が長すぎる文言を表示した後の画面の状態（録音していない、両方の国旗が押せる、読み上げボタンがない、翻訳カードが処理中でない、履歴が増えない）が、`/api/interpret` のほかのエラー（502）のときと同じであること

録音のライフサイクル（[speech-flow.md](speech-flow.md) の「6. 録音のライフサイクル」）は、次のテストで確かめます。通訳の画面のテスト（`InterpreterPage.lifecycle.test.tsx` など）は、録音のセッション（`useKeptAudioSession`。マイクを閉じない）の期待です。`getUserMedia`、`MediaRecorder`、`SpeechRecognition`、`AudioContext`、`requestAnimationFrame` の代わりは `frontend/src/test/audioMocks.ts` にまとめています。`getUserMedia` と `fetch` は、テストが resolve や reject をするまで終わらず、`MediaRecorder` の `ondataavailable` と `onstop` はテストが起こします。

- `starting` の間にもう一度タップしても、`getUserMedia` は1回だけであること
- `getUserMedia` を待っている間に、`hidden`、`pagehide`、戻る、外れるが起きたら、録音を始めず、後から成功した stream は閉じずに `keptMic` が持ち、次の録音で `getUserMedia` を呼ばずに使うこと（待っている間の2回目の開始は、同じ `getUserMedia` を待つこと）
- `getUserMedia` の成功の後に、`MediaRecorder` の作成や `start()` が失敗した場合、audio track がない場合、track が `live` でない場合に、track を止めずに、`recording_start_failed` を2つの言語で表示し、`idle` に戻ること。`ended` の track があれば、次の録音の開始で止めてから取り直すこと。`getUserMedia` の失敗は `microphone_denied` のままであること
- 音量の取得や音声認識が失敗しても、録音は成立し、利用者の停止で Backend に送ること
- 利用者の停止で、最後の `ondataavailable` の後に送ること。track は `stop()` しないこと
- 片付けの順番（[speech-flow.md](speech-flow.md) の 6.4 の「片付けの順番」）。音声認識の停止、`requestAnimationFrame` の取り消し、`MediaStreamAudioSourceNode` の `disconnect()`、`AudioContext` の `close()` の開始が、`MediaRecorder` の `stop()` より先であること（`useKeptAudioSession.test.ts`）。どの経路（利用者の停止、`onstop` の後、`hidden`、`pagehide`、戻る、外れる、`error`、`recording_start_failed`、`MediaRecorder` が自分で止まった、`onerror`、見張りのタイマー、`stop()` の例外）でも track の `stop()` を呼ばないこと
- 録音中や `stopping` の間に `hidden` になったら、Backend に送らず、track を止めずに録音の資源を片付け、`idle` に戻ること。後から来た `onstop` が何もしないこと。`visible` に戻っても自動で録音を始めないこと
- 音声認識の `onend` で、止める指示の後や、無効なセッションでは始め直さないこと
- 片付けを2回、3回と続けて呼んでも、例外や二重の `stop()` が出ないこと。`AudioContext` の `close()` の拒否や、音声認識の `stop()` の例外を捨てること
- 利用者の停止の後（`stopping` の間）に中断した場合、`abort` の Promise は、利用者の停止で始めた `AudioContext` の `close()` が終わるまで解決しないこと。`close()` が拒否されても `abort` の Promise は解決し、未処理の拒否が出ないこと。`close()` と `disconnect()` は1回だけであること（KK1）
- 止める指示と音量の取得の片付けの後に音量の取得を始めようとしても、`AudioContext` を作らず、`requestAnimationFrame` も頼まないこと（KK4）。今の画面からは起きない経路なので、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります。その後の `onstop` で送り、track は止めないこと（`useKeptAudioSession.test.ts`。録音の成立の callback の中の中断（`abort`）で、音量の取得と音声認識を始めないことも確かめます）
- 止める指示の後に音声認識を始めようとしても、音声認識の constructor も `start()` も呼ばないこと（KK5）。KK4 と同じく、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります（`useKeptAudioSession.test.ts`）
- 録音の途中の `MediaRecorder` の `onerror` で片付けて、`recording_failed` を表示すること（録音の成立の前の失敗は `recording_start_failed` のまま）
- 利用者の停止で `MediaRecorder` がすでに `inactive`（`onstop` が未着）のときは、`onstop` を待ち、最後のデータを含めて送ること。`onstop` が利用者の停止の前に届いていたときは送らないこと
- 利用者の停止で `MediaRecorder` の `stop()` が例外を出したときは、Backend に送らず、track を止めずに、`recording_failed` を2つの言語で表示し、`idle` に戻ること。診断のログに `recorder_stop_failed:<name>` が残ること
- 利用者の停止の後、`onstop` が見張りの時間（`RECORDER_STOP_TIMEOUT_MS`、10 秒）届かないと、track を止めずに、`recording_failed` を表示し、`idle` に戻ること（`recorder_stop_timeout`）。テストは時間を数字で書かず、定数を参照します。9 秒台で `onstop` が届いた場合は、録音の失敗にならずに送ること。待っている間に中断した場合、古いセッションのタイマーの場合は、タイマーが何もしないこと
- 診断の情報に、`stop()` から `onstop` までの時間（`stopLatencyMs`。`MediaRecorder` がすでに `inactive` のときは、止める指示を記録してから）が残ること。見張りのタイマーで片付けた場合は、`stopTimedOut` と待った時間（`stopWaitedMs`）が残り、後から届いた `onstop` までの時間も残ること
- 録音の途中で track が `ended` になり、`MediaRecorder` が自分で止まると、`recording_failed` を表示して `idle` に戻り、Backend に送らないこと。診断のログに `recorder_stopped_unexpectedly` が残ること。次の録音の開始で、`ended` の track を止めてから `getUserMedia` で取り直すこと。`ended` は `keptMic` の `endedEvents` に記録され、録音のセッションは track に listener を付けないこと
- `ready` 以外では読み上げを押せないこと。読み上げの途中に `hidden`、`pagehide`、戻る、外れる、編集が起きたら、今鳴らしている `AudioBufferSourceNode` の `stop()` と `disconnect()` を呼び、後から来た `onended` が画面を変えないこと（`hidden` と `pagehide` では `ready` に戻ること。外れるときは読み上げの `AudioContext` を `close()` すること）。`/api/tts` を待っている間に止めた場合は、後から来た音声を `decodeAudioData` せず、再生しないこと。`<audio>` を使わないこと
- 音の扱いの宣言（GOTALK-17。`audioSessionType.test.ts` と `InterpreterPage.audioSessionType.test.tsx`）：`navigator.audioSession` があるとき、読み上げのタップの処理の中で、`new AudioContext()` と `resume()` より前に `type` を `play-and-record` にすること（setter の spy と、呼ばれた順番で確かめます）。話さずに入力した後、写真の後（`InterpreterPage.photo.test.tsx`）、話した後の読み上げでも設定すること。すでに `play-and-record` なら設定し直さず（冪等）、診断の出来事 `audio_session_type:play-and-record` をタップごとに残すこと。`navigator.audioSession` がないときは `audio_session_unsupported`、setter が例外を出したときは `audio_session_set_failed:<name>` を残し、どちらも今までどおり鳴らし、文言を出さないこと。500 文字を超えて読み上げないときは設定しないこと。読み上げの後に初めて話しても、`getUserMedia` は1回だけで、track の `stop()` を呼ばず、`enabled` も変えないこと
- 古いセッションの callback（`getUserMedia` の完了、`ondataavailable`、`onstop`、`onerror`、音声認識の `onresult` と `onend`、`requestAnimationFrame`）が新しいセッションを壊さないこと
- `processing` の間に `hidden` になっても状態は `processing` のままで、国旗を押せず、結果が来たら `ready` になること。戻るや `pagehide` のときは問い合わせを止め、後から結果や失敗が来ても画面に反映しないこと
- 止めた問い合わせ1の結果が遅れて戻っても、画面には問い合わせ2の結果だけが出ること
- `handleSpeak` の守りが働いたときに、`unexpected_active_audio_session_before_tts` が診断のログに残り、片付けが終わってから `/api/tts` を呼ぶこと。読み上げの `AudioContext` を作れないときも、戻る前に同じ記録と片付けをし、`/api/tts` を呼ばないこと（QQ1）
- bfcache から戻ったとき（`pagehide` と `pageshow` の `persisted: true`）に、`starting`、`recording`、`stopping`、`processing` は `idle` に、`ready` と `speaking` は `ready` に直り、録音を始めず（`getUserMedia` も呼ばず）、問い合わせも送らないこと。`pageshow` のときに画面がまだ `processing` でも、記録した状態に直すこと。`persisted: false` の `pageshow` では何もしないこと。bfcache から戻った後に始めたセッション2が、セッション1の古い callback の影響を受けず、同じマイクを使い回すこと
- 診断の情報に、録音ごとの数値（`getUserMedia` の時刻、track の状態、録音の大きさ、音量、音声認識の文字数など）が残り、会話の本文が残らないこと

利用者向けの文言を選んだ2つの言語で表示すること（[ui.md](ui.md)）は、次のテストで確かめます。画面のテストの期待する文言は、既定の日本語と英語の組み合わせでは helper `jaEn` で作ります。エラーのときの `console.warn` は、ログを確かめるテスト以外では `beforeEach` で出力を止めています。

- `getLocalizedMessage` が、2つの言語（`ja` と `en`、`th` と `vi` など）の文言を選んだ順に空行をはさんで連結すること、辞書にない言語では英語になること、選んだ言語が1つだけのときはその言語の文言だけ、1つもないときは英語の文言になること（`messages.test.ts`）
- 17 の文言のすべてのキーに、7言語の空でない文言がそろっていること。`recording_start_failed`、`recording_failed`、`microphone_no_audio` の7言語の文言が決めたとおりであること（日本語だけ句点なし）。読み上げの文言の 500 が `TTS_MAX_CHARS` から作られること。`request_timeout` の英語の文言のアポストロフィが U+2019 であること。2つの文からなる日本語の文言（写真の翻訳のほかの 11 のキー）が決めたとおりで、文と文の間が改行の2行であること。17 のキーすべての日本語の文言が、句点（。）も読点（、）も含まないこと（`messages.test.ts`）
- 13 の文言のそれぞれが、実際の画面で選んだ2つの言語（主にタイ語とベトナム語。ほかにベトナム語とタイ語の順、韓国語と英語）で表示されること（`InterpreterPage messages in the two selected languages`）
- 対応する文言がない status（502）、ネットワークのエラー（`fetch` の reject）、JSON として読めない応答で汎用のエラーの文言を表示し、`HTTP`、`502`、`Failed to fetch`、Backend の `error` の文字列を表示しないこと
- Frontend の timeout では「うまく翻訳できませんでした」、Backend の 504 では「処理に時間がかかっています」を表示すること
- エラーのとき、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`recording_too_large_before_send`、`TypeError` など）が残り、発話の内容、翻訳の結果、`e.message`、Backend の `error` の文字列が残らないこと（`api.test.ts` と `InterpreterPage.test.tsx`）
- ログの `reason` に入る `code` が `^[a-z0-9_]{1,64}$` に一致しない場合（大文字、空白、65 文字、日本語、改行、空文字）は `invalid` になり、元の文字列がログに出ないこと。一致する場合（`upstream_busy`、許可リストにない `some_new_code`、64 文字）はそのまま出ること。表示の判定は変わらないこと（`api.test.ts`。`/api/tts` は `InterpreterPage.test.tsx`）
- 読み上げで表示する文言がない場合（502、ネットワークのエラー）に、何も表示しないこと

`/api/interpret` の結果表示やエラー処理のテストは、`MediaRecorder` と `navigator.mediaDevices.getUserMedia` を mock し、国旗をタップして録音を開始し、同じ国旗をタップして停止することで `/api/interpret` を呼びます（停止は `handleFlagTap` の `recording` の分岐を通ります。録音中の画面のタップと同じ `stopRecording()` を呼ぶ守りの分岐で、実際の操作の停止（録音中の画面のタップ）は `InterpreterPage.recordingOverlay.test.tsx` で確かめます）（共通の手順は helper `renderAndInterpret` にまとめています）。これらのテストでは `SpeechRecognition` を mock していないため、`transcript` は送られません。`transcript` の送信は、`SpeechRecognition` を mock した国旗タップのテスト 1 件で検証します。

通訳の画面の TTS のテストでは、`frontend/src/test/audioMocks.ts` の `setupAudioContext()` で、`AudioContext` の `resume()`、`decodeAudioData()`、`createBufferSource()`、`destination`、`close()` と、`createBufferSource()` が返す `AudioBufferSourceNode` の `connect()`、`start()`、`stop()`、`disconnect()`、`onended` を差し替え、`/api/tts` の応答は `arrayBuffer()` で返します（`makeTtsOkResponse()`）。`Audio` を置くテスト（`InterpreterPage.lifecycle.test.tsx`、`InterpreterPage.keptMic.test.tsx`、`InterpreterPage.ttsGuard.test.tsx` の QQ1 のテスト）では、`Audio` は再生に使う mock ではなく、`<audio>` の経路に戻っていないこと（呼ばれないこと）を確かめるための spy です。通訳の画面の TTS のテストでは object URL（`URL.createObjectURL`、`URL.revokeObjectURL`）は使いません。音の扱いの宣言（GOTALK-17）は、`setupAudioSessionType()` で `navigator.audioSession` を差し替え（`type` の setter は spy。`initialType`、`throwOnSet` を指定できます）、`removeAudioSessionType()` で、ないブラウザにします。`navigator.mediaDevices`、`navigator.audioSession`、`AudioContext`、`Audio` などは各テストの前の状態を `beforeEach` で保存し（`AUDIO_GLOBALS`）、`afterEach` で元に戻します。`MediaRecorder` と `window.SpeechRecognition` は `afterEach` で削除します。API 呼び出しは `fetch` mock で検証します。

### 診断の表示（?diag）

通訳の画面の診断の表示（「更新」「コピー」と、「コピー」の JSON）は、開発と不具合の調べのためのものです（`frontend/src/pages/DiagnosticsPanel.tsx`）。

- URL の query に `diag` があれば（値は見ません。`?diag`、`?diag=`、`?diag=0` のどれでも）、通訳の画面の下に「更新」「コピー」を出します。大文字の `?DIAG` と hash の `#diag` では出しません
- 読むのは画面を読み込んだときの一度だけで（`App.tsx`）、途中で URL を変えても反映しません
- `?exp=` は何もしません（付けても、ふつうの画面のままで、診断も出ません）
- 「更新」は、押したときの診断の情報で、直近の5回の録音（止めた理由、mimeType、bytes、track の状態）を表示します。表示は押したときだけ変わります
- 「コピー」の JSON の形：`kind`（`audioSession`）、`takenAt`、`diagnostics.sessions`（録音ごと。直近の 10 回）、`diagnostics.events`（直近の 200 件）、`diagnostics.keptMic`（`getUserMediaCalls` と `endedEvents`）。クリップボードに写せないときは、選んで写せる欄に出します
- 録音中（`starting`、`recording`、`stopping`）は押せません
- 記録の持ち方：**`sessions` と `events` は通訳の画面ごと**に持ち、言語の選択に戻って通訳の画面を開き直すと空から始まります。**`keptMic` はページ全体**で持ち、言語の選択に戻っても続きの値です（ページを読み込み直すと初めに戻ります）
- 会話の本文と録音した音声は残しません（音声認識は、結果があったかと文字数だけ）
- 定期的な読み取り、新しい timer、出来事ごとの再描画はしません

### 実機の確認の手順

これまでの PR で行った実機の確認の手順です。同じところを変えたときや、不具合を調べるときに使い直します。診断の「コピー」の JSON は、`?diag` を付けて開いて取ります（[診断の表示（?diag）](#診断の表示diag)）。

#### PR A（マイクを開いたまま使い回す）の後の実機の確認

PR A で、本番の通訳の画面を、マイクを開いたまま使い回し、読み上げを `AudioContext` で鳴らし、マイクの音が来ないときに知らせる形にしました（[speech-flow.md](speech-flow.md) の 6.1、8.1、9）。マイクの扱いや読み上げを変えたときは、この手順で確かめます。

iPhone の Safari と Chrome のそれぞれで、ブラウザを終了してから開き、次を行います。診断の「コピー」の JSON を取るため、`?diag` を付けて開いて（例：`https://staging.gotalk.chiemaru.com/?diag`）行います。

1. 10 回話す（毎回「わたしのなまえはありたしんです」）。3回目と7回目の後に読み上げる。毎回、次を書き留める
   - お知らせ（「マイクへのアクセスが許可されています」）が出たか
   - 翻訳が出たか
   - 読み上げがスピーカーからふつうの音量で聞こえたか（3回目と7回目の後）
2. 言語の選択の画面に戻り、もう一度選んで1回話す
3. ブラウザを裏に回して 10 秒ほど待ち、戻って1回話す
4. ページを読み込み直して1回話す
5. 最後に診断の「コピー」の JSON を取る。3 と 4 の後にも JSON を取り、`diagnostics.keptMic.getUserMediaCalls`（`getUserMedia` を呼んだ回数）と `diagnostics.keptMic.endedEvents`（iPhone が track を止めたか）を記録する（記録するだけで、成功の条件にはしない。`microphone_no_audio` が出たときの原因の切り分けに使う）

成功の条件：

- 1 と 2 で、お知らせは最初の1回だけ、毎回翻訳が出る、「しん」が別の名前にならない、読み上げが最後まで鳴り、直後の録音も成功する
- 3 と 4 で、録音できたか、できなかったときに `microphone_no_audio`（「マイクの音を受け取れませんでした」「ブラウザを一度終了してから開き直してください」の2行）が出たかを記録する（検出が働くことが条件。録音できるかどうかは iPhone の動きなので条件にしない）
- 読み上げの音量：ふつうに聞こえることが条件。小さい（受話口から鳴る、など）ときは失敗とし、扱いを利用者が決める（マイクを開いたまま鳴らすと、iPhone が音の出口を変えることがあるため）
- 診断：「コピー」の JSON の `diagnostics.events` で、正常に鳴り終わった読み上げについて `tts_ended_timeout` が 0 件であること（見張りのタイマーが誤って働いていないこと）。`no_audio_detected` の有無も確かめる

判断の仕方：1 か 2 が失敗なら、マイクの扱い（マイクを開いたまま使い回す作り）の動きを見直す。

#### PR B（録音中の画面）の実機の確認

PR B で、録音中にグレーの画面（録音中の画面。[ui.md](ui.md) の「録音中の画面」）を出し、画面のタップで話し終われるようにしました。読み上げの時間の記録（[speech-flow.md](speech-flow.md) の「9. TTS」の「読み上げの時間の記録」）も足しました。確かめるときは、ステージング（`https://staging.gotalk.chiemaru.com/?diag`）で、iPhone の Safari で行います。手順ごとに、期待値を先に伝えてから行います。

1. Safari を終了してから開き、国旗をタップする
   - 期待値：すぐにグレーの画面が出て、押した国旗の言語で案内の文言（日本語なら「話し終わったら画面をタップしてください」）、下に × のボタンが出る。マイクの準備ができると ■ に変わる。マイクのお知らせは最初の1回だけ
2. 話す
   - 期待値：話した文字がグレーの画面の上に出て、文字が増えている間だけ棒グラフが動く。黙ると1秒ほどで棒が止まる。長く話すと、文字が下に流れて最新の文字が見え続ける。国旗のまわりは動かない
3. 画面の真ん中をタップする
   - 期待値：グレーの画面が消え、「ただいま翻訳中です」の後に翻訳が出る。言語の選択に戻らない
4. もう一度話して、■ をタップする
   - 期待値：3 と同じ
5. もう一度話して、透けて見えている「GoTalk」の題名の上をタップする
   - 期待値：録音が終わって翻訳が出る。言語の選択には戻らない
6. 国旗をタップしてすぐ（■ に変わる前に）× をタップする
   - 期待値：グレーの画面が消え、何も出ずに元の画面に戻る（× が見えている時間は短いので、間に合わなければ省いてよい）
7. 翻訳が出た後に読み上げを押す
   - 期待値：鳴る。押してから鳴るまでの体感の秒数を覚えておく
8. ここで診断の「コピー」の JSON を取る
   - **言語の選択に戻る前に取る**（`sessions` と `events` は通訳の画面ごとに作られ、言語の選択に戻ると空から始まるため。`keptMic` はページ全体の値で、続きの値になる）
   - `diagnostics.events` の `tts_tap`、`tts_response:status=…`、`tts_downloaded:bytes=…`、`tts_decoded:ms=…`、`tts_started` の `at` の差で、押してから応答まで（OpenAI と通信）、ダウンロード、変換、再生の開始までの時間を分ける。同じ時刻の Backend のログの `tts: runes=… bytes=… openai_ms=…` と合わせて、OpenAI の時間と通信の時間を分ける

棒グラフの仕様：棒グラフは、音声認識の途中の文字が更新されている間だけ動きます。声そのものを検知しているのではないので、話していても認識の文字が更新されなければ止まります（音声認識が遅れたとき、聞き取れなかったときなど）。2 で棒が止まっても、文字が更新されていなければ期待どおりです。

#### GOTALK-6（話さなくても文字を入力して翻訳する）の実機の確認

GOTALK-6 で、原文のカードの鉛筆のボタンを最初から押せるようにし、話さなくても文字を打って翻訳できるようにしました（[ui.md](ui.md) の「原文の入力と編集」）。確かめるときは、ステージング（`https://staging.gotalk.chiemaru.com/`）で、iPhone の Safari と Chrome のそれぞれで行います。手順ごとに、期待値を先に伝えてから行います。

1. 言語を選んで通訳の画面を開き、話さずに右の鉛筆のボタンをタップする
   - 期待値：キーボードが出て、原文のカードで文字を打てる
2. 「駅はどこですか」と打ち、画面の何もないところをタップする
   - 期待値：キーボードが閉じ、「ただいま翻訳中です」の後に、選んだ相手の言語の翻訳と逆翻訳が出る
3. 鉛筆のボタンをタップし、文を消して、相手の言語（例：英語の「Where is the station?」）で打ち、国旗の上をタップする
   - 期待値：確定して日本語に訳される。そのタップでは録音は始まらない
4. 国旗をタップして話す
   - 期待値：今までどおり録音できる
5. 鉛筆のボタンの大きさと位置を見る
   - 期待値：原文の行の高さに収まり、押しやすい
6. 鉛筆のボタンをタップし、日本語のキーボードで「えきはどこですか」と打ち、変換の候補から「駅」を選ぶ（変換を確定する）
   - 期待値：変換が確定するだけで、翻訳は始まらない
   - 続けて画面の何もないところをタップする。期待値：確定して翻訳が出る
7. 鉛筆のボタンをタップして文字を打ち、もう一度、鉛筆のボタンの位置をタップする
   - 期待値：確定して翻訳が出る
8. 翻訳が出た後に、鉛筆のボタンで文字を打ち、読み上げのボタンの上をタップする
   - 期待値：確定して翻訳が出る。読み上げは鳴らない
9. 鉛筆のボタンで文字を打ち、上の「GoTalk」の題名の上をタップする
   - 期待値：確定して翻訳が出る。言語の選択には戻らない
10. `?diag` を付けて開き（`https://staging.gotalk.chiemaru.com/?diag`）、鉛筆のボタンで文字を打ち、画面の下の「コピー」の上をタップする
    - 期待値：確定して翻訳が出る。コピーは起きない

#### GOTALK-7（カメラで撮った文字を翻訳する）の実機の確認

GOTALK-7 で、原文のカードの左にカメラのボタンを足し、写真の中の文字を行ごとに訳せるようにしました（[ui.md](ui.md) の「8. 写真の翻訳」）。確かめるときは、ステージング（`https://staging.gotalk.chiemaru.com/`）で、iPhone の Safari と Chrome のそれぞれで、次の写真を試します。ステージングは `OPENAI_VISION_MODEL` と `OPENAI_VISION_REASONING_EFFORT` を Compose から渡さないので、既定の値（`gpt-6-luna`、`none`）で動きます。

- 写真を撮る、写真ライブラリ、スクリーンショット、横向きの写真、HEIC、文字のない写真、文字の多い写真
- 上限の近く（1,032,192 バイト）の JPEG を multipart で送って、nginx を通ること（Shin の Mac から `curl` で確かめる。手順は Claude.ai が用意する）
- 費用は、OpenAI のステージングの Project の使用量で確かめる

#### GOTALK-17（マナーモードでも読み上げが鳴るようにする）の実機の確認

GOTALK-17 で、読み上げの前に音の扱いを `play-and-record` と宣言するようにしました（[speech-flow.md](speech-flow.md) の「9. TTS」）。確かめるときは、ステージング（`https://staging.gotalk.chiemaru.com/?diag`）で、iPhone の Safari と Chrome のそれぞれで、マナーモードのオンとオフの両方で行います。どの手順も、ブラウザを一度終了して開き直してから始めます（マイクを開いていない状態から始めるため）。「コピー」の JSON の `diagnostics.events` に、`audio_session_type:play-and-record` が残るか（Chrome で `audio_session_unsupported` にならないか）も見ます。

1. 話さずに鉛筆のボタンで文字を打って翻訳し、読み上げを押す
   - 期待値：マナーモードでも聞こえる。スピーカーから出て（受話口からではなく）、音量はマイクを開いた後の読み上げと同じくらい
2. 写真の翻訳の後に、読み上げを押す
   - 期待値：1 と同じ
3. 国旗をタップして話し、その翻訳の読み上げを押す
   - 期待値：今までどおり聞こえる
4. 1 の後に、初めて国旗をタップして話す。続けて「話す → 読み上げ」を 10 回繰り返す
   - 期待値：毎回録音でき、原文と翻訳が出る。「マイクの音を受け取れませんでした」が出ない。2回目から「マイクへのアクセスが許可されています」のお知らせが出ない（`diagnostics.keptMic.getUserMediaCalls` が 1 のまま）
5. マイクを開く前（1 の読み上げの間と後）のオレンジ色のマイクの表示を見る
   - 期待値：マイクを開く前は点かない
6. ほかのアプリ（ミュージックなど）で音楽を流したまま、GoTalk で読み上げを押す
   - 期待値：音楽が止まるか小さくなるかを記録する（マイクを開いた後の読み上げと同じ動きなら問題なし）

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

Docker Compose には Backend 開発用の `backend-dev` service があります。`./backend` を `/app` に mount し、Go command を実行できます。`./frontend/src/languages.ts` も、読み取りだけで `/frontend/src/languages.ts` に mount します。Backend のテスト（`TestSupportedLanguagesMatchFrontend`）が `../frontend/src/languages.ts` を読み、Backend の対応言語が Frontend の言語の一覧と一致するかを確かめるためです。`backend-dev` は `profiles: ["dev"]` に属していますが、`docker compose run --rm backend-dev ...` は `--profile` を付けずに実行できます。

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
