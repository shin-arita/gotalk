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
| `frontend/src/api.test.ts` | API の timeout の値、エラーの `code` ごとの文言のキー（`apiErrorFromResponse`）、エラーの文言のキーとログ（`messageKeyForError`）、読み上げの文字数の判定（`isTooLongForTts`）、`/api/interpret` に送る録音と `/api/photo` に送る写真の大きさの上限（`MAX_UPLOAD_BYTES`。前の名前の `MAX_INTERPRET_AUDIO_BYTES` が同じ値であること） |
| `frontend/src/messages.test.ts` | 利用者向けの文言の共通の関数（`getLocalizedMessage`）と、17 の文言の7言語の辞書 |
| `frontend/src/pages/LanguageSelectPage.test.tsx` | 言語選択画面 |
| `frontend/src/pages/InterpreterPage.test.tsx` | 通訳画面、録音、確定翻訳、再翻訳、TTS、読み上げの文字数の上限、状態遷移、エラーの文言を選んだ2つの言語で表示すること |
| `frontend/src/hooks/useAudioSession.test.ts` | 録音のセッションの hook（`createAudioSession`、`useAudioSession`）：録音の成立と失敗、利用者の停止、中断の片付け、古いセッションの callback、冪等な片付け、診断の情報 |
| `frontend/src/audio/keptMic.test.ts` | ページ全体で1つのマイク（`keptMic`）：2回目からは `getUserMedia` を呼ばない、`ended` の track があれば古い track を止めて取り直す、同時の `acquire()` で `getUserMedia` は1回、失敗と `pending`、`ended` の listener は track ごとに1回だけ、`endedEvents` |
| `frontend/src/hooks/useKeptAudioSession.test.ts` | マイクを閉じない録音のセッション（`createKeptAudioSession`、`useKeptAudioSession`、`useInterpreterAudioSession`）：どの経路でも track の `stop()` を呼ばない、使い回しのときは `start()` の同期の処理の中で `MediaRecorder.start()` を呼ぶ、片付けの順番、`getUserMedia` を待つ間の中断、`useAudioSession` と同じ意味の安全策、スイッチによるセッションの選び方 |
| `frontend/src/pages/InterpreterPage.lifecycle.test.tsx` | 通訳画面の録音のライフサイクル（マイクを閉じないセッション）：二重のタップ、中断（`hidden`、`pagehide`、戻る、外れる）で track を止めず次の録音で使い回すこと、古いセッションと古い問い合わせの結果、読み上げの中断（`AudioBufferSourceNode` の `stop()` と `disconnect()`、外れるときの `AudioContext` の `close()`）、bfcache から戻ったとき |
| `frontend/src/pages/InterpreterPage.keptMic.test.tsx` | 10 回続けて録音しても（間に読み上げをはさんでも）`getUserMedia` は1回、読み上げの `AudioContext`（`resume()` をタップの中で `fetch` の前に呼ぶ、`resume()` の拒否と `running` でないとき、古い `resume()` の拒否、見張りのタイマー、`decodeAudioData` と `start()` の失敗）、マイクの音が来ないときの検出、`?exp=` のときの「コピー」の JSON、スイッチがあるときは `useAudioSession` を使うこと |
| `frontend/src/App.keptMic.test.tsx` | 言語の選択の画面に戻り、もう一度選んで録音しても `getUserMedia` を呼ばないこと |
| `frontend/src/pages/InterpreterPage.recordingOverlay.test.tsx` | 録音中の画面（PR B）：押した国旗の言語の1言語の案内と、下のボタン（starting は × とキャンセル、recording は ■ と停止）、画面のどこをタップしても1回だけ止めること、starting の間の本体のタップは何もしないこと、× の取り消し（`abort('cancel')`）、click shield（消えた後の 400ms はタップを受け止める。jsdom は hit test と `inert` をしないので、テストの `tapAt()` で一番上に重なる要素に click を届ける）、話した文字だけを出し、録音中に `/api/translate` を呼ばないこと（入力中の翻訳はしない）、末尾へのスクロール、棒グラフ、中断と失敗で消えること、`inert` とフォーカス、読み上げの時間の記録（`tts_tap` から `tts_started` まで） |
| `frontend/src/pages/InterpreterPage.textInput.test.tsx` | 原文の入力と編集（GOTALK-6）：原文が空でも押せること（`aria-label` は「入力」）、タップの処理の中でのフォーカス、透明な覆い（`edit-confirm-shield`）のタップで確定し、そのタップで国旗、題名、読み上げが動かないこと（テストの `tapAt()` で、原文のカードの外へのタップを覆いに届ける）、原文のカードの余白と鉛筆のボタンの位置のタップ、Enter と日本語の入力の変換の Enter、Escape、`blur`、録音中と翻訳中に押せないこと、`language_mismatch`。フォーカスがないまま編集の状態になったときの確定（PR #37 の UU1）、中断のときの編集の扱い（`hidden` では続け、`pagehide`、`pageshow`、`unmount` では取り消す。UU2） |
| `frontend/src/pages/InterpreterPage.photo.test.tsx` | 写真の翻訳（GOTALK-7）：カメラのボタンの位置と押せるとき（`idle` と `ready` だけ）、タップの処理の中で `input` の `click()` を呼ぶこと、編集の間にその位置をタップすると写真を選ぶ画面を開かずに確定すること、取り消し、`input` を空に戻すこと。前処理（偽の `createImageBitmap` と canvas。向きの指定、長辺 1280px、拡大しない、品質 0.8、超えたら 0.6 で1回、それでも超えたら送らずに `photo_too_large`）、前処理の途中は `processing` で国旗、鉛筆、カメラ、読み上げのボタンが押せないこと、`/api/photo` に送る `image` と `languages`。`createImageBitmap()` と `toBlob()` の失敗と `null` で `photo_load_failed`（`close()` と canvas の片付けも行う）、`fetch` のネットワークの失敗は `generic_error`、65 秒の時間切れは `request_timeout`。前処理の途中の `pagehide`、戻る、外れるで送らず、止めた後の失敗で文言も状態も変えないこと（外れた後の警告も出ないこと）、`hidden` では続けること、問い合わせの途中の `pagehide` の後の失敗で文言を出さないこと。`no_text_found`、`photo_too_much_text`、413（Backend の JSON と nginx の HTML）、504 の文言を選んだ2言語で出すこと。成功の表示（原文のカード、1組ずつの表示、逆翻訳の欄を出さない）、`ttsText` の読み上げ、500 文字を超える `ttsText`、履歴の1件（`other` のときの日付の表示の言語）、写真の行を消すとき（国旗、編集の確定、次の写真） |
| `frontend/src/pages/InterpreterPage.ttsGuard.test.tsx` | `handleSpeak` の守り（`useInterpreterAudioSession` を差し替えて、`ready` で録音のセッションが残っている状態を作る） |
| `frontend/src/pages/InterpreterPage.ttsCache.test.tsx` | 読み上げの音声を取っておくこと（GOTALK-2）：同じ翻訳を2回読むと `/api/tts` と `decodeAudioData` は1回で、鳴らすのは2回（2回目は `tts_cache_hit`）、録音し直す、編集して訳し直す、文字を入力して訳すと新しい文字で `/api/tts` を呼ぶこと、訳し直しで同じ `ttsText` が返ったときは呼ばないこと、`/api/tts` の失敗と時間切れ（応答を待つ途中と、本文の受け取りの途中。本文の受け取りの途中は PR #38 の VV4）、`decodeAudioData` の失敗、変換の確認より前の `hidden` の後は取っておかないこと、`decodeAudioData` の途中で時間切れになったときは、その回は鳴らすが取っておかないこと（PR #38 の VV3）、取っておいた後の `resume()` の拒否と `running` でないとき、`AudioBufferSourceNode` の `start()` の失敗、見張りのタイマー、中断（`hidden`、`pagehide`）、読み上げの途中に原文の編集を確定して訳し直しで同じ `ttsText` が返ったとき、読み上げの途中の `pagehide` と `pageshow`（persisted。bfcache から戻ったとき）の後も取っておいた音声を使うこと（PR #38 の VV2）、画面を付け直すと使わないこと |
| `frontend/src/pages/MicTestPage.test.tsx` | 開発用のマイクの確認のページ（`#mic-test`） |
| `frontend/src/experiments.test.ts` | 切り分けの実験のスイッチの指定（`ExperimentConfig`）の読み取りと組み合わせ（[切り分けの実験のスイッチ](#切り分けの実験のスイッチ原因の特定の後に外す)） |
| `frontend/src/hooks/useAudioSession.callLog.test.ts` | `useAudioSession` に、スイッチがないとき（と `?exp=` のとき）の設定を渡したときに、ブラウザの API の呼び出しの順番と回数が、スイッチを入れる前（`782635e`）と同じであること（PR A から、通訳の画面は、スイッチがないときに `useAudioSession` を使いません） |
| `frontend/src/hooks/useAudioSession.experiments.test.ts` | `useAudioSession` のスイッチごとの動きと、実験の診断の記録 |
| `frontend/src/pages/InterpreterPage.experiments.test.tsx` | 通訳の画面のスイッチ（`norecog`、`nolifecycle`、`trace`）と、診断の表示（「更新」「コピー」。録音ごとの実験の記録を確かめるものは `trace` を付けている） |
| `frontend/src/pages/ExperimentPanel.test.tsx` | 診断の表示の部品（スナップショットの表示、直近の5回分、クリップボードがないときの表示） |
| `frontend/src/hooks/useAudioSession.recognitionVariants.test.ts` | 2回目の実験のスイッチ（`recogfirst`、`recogabort`、`recogdelay`、`recogearly`、`recogonce`）ごとの動きと診断の記録、スイッチがないときに待ちやタイマーを作らないこと |
| `frontend/src/pages/ExperimentPanel.recognitionVariants.test.tsx` | 2回目の実験の診断（`recogfirst` の待ち、`recogearly`、`recogonce`）の表示 |
| `frontend/src/pages/LegacyInterpreterPage.test.tsx` | `legacy` の部品。`07f06f0` の `InterpreterPage.test.tsx` を、import だけを変えて残したもの |
| `frontend/src/pages/LegacyInterpreterPage.experiments.test.tsx` | `legacy` の部品の実験の記録と、足していないもの（`useAudioSession`、track の読み取り、listener） |
| `frontend/src/pages/LegacyInterpreterPage.keepStream.test.tsx` | `legacykeep`（3回目の実験）のマイクの使い回しと記録、`getUserMedia` を待つ間の2回目の操作と画面の外れの守り。`legacy` とスイッチがないときに、今までどおり録音ごとに `getUserMedia` を呼び、track を止めること |
| `frontend/src/pages/LegacyInterpreterPage.legacyMute.test.tsx` | `legacymute`（4回目の実験）の track の無効（`onstop` の後）と有効（次の録音の開始で、`MediaRecorder` を作る前）、開始の途中の失敗で無効に戻すこと（音声認識の constructor の例外では、始めた `MediaRecorder` を止めて翻訳に送らず、そのデータを次の録音に混ぜないこと。`legacykeep` と `legacy` では今までどおり録音中のまま残ること）、録音ごとの `recordingNo` と track の状態の記録、読み上げの記録と表示。`legacykeep`、`legacy`、スイッチがないときに、`enabled` を書き換えず、読み上げの記録を作らないこと |
| `frontend/src/pages/LegacyInterpreterPage.recogOnly.test.tsx` | `recogonly`（5回目の実験）の開始（`getUserMedia`、`MediaRecorder`、`AudioContext` を使わず、操作の中で同期的に `start()` を呼ぶ。部品がないとき、部品の constructor の例外、最初の `start()` の例外）、利用者の終了、自動の終わりと始め直し（文字の確定、20 回の上限、`start()` の例外）、時間切れ、`discard`（`not-allowed`、`service-not-allowed`、画面が外れたとき）、空の文字、`/api/interpret` に送る形と `interpretResult`、出来事と記録（上限、遅れて来た出来事、スナップショット、「コピー」の JSON）、読み上げの記録 |
| `frontend/src/recogOnlyText.test.ts` | `recogonly` の文字のつなぎ方（`joinRecognitionSegments`。7言語の区切り、片方が空、すでに空白がある） |
| `frontend/src/App.test.tsx` | `exp` に `legacy`、`legacykeep`、`legacymute`、`recogonly` のどれかがあるときだけ `LegacyInterpreterPage` を使うこと |

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
- `/api/interpret` が 413 を返したときに、本文が nginx の HTML でも、Backend の JSON（`input_too_large`）でも、空でも「録音が長すぎます。短く区切って話してください。」を表示すること。413 以外のエラー（502 `upstream_error` など）は、汎用のエラーの文言であること
- 録音の Blob が 1,032,192 バイトちょうどなら `/api/interpret` を呼び、1 バイトでも超えたら呼ばずに同じ文言を表示すること
- `/api/translate` と `/api/tts` の 413 の表示は変わらないこと
- 録音が長すぎる文言を表示した後の画面の状態（録音していない、両方の国旗が押せる、読み上げボタンがない、翻訳カードが処理中でない、履歴が増えない）が、`/api/interpret` のほかのエラー（502）のときと同じであること

録音のライフサイクル（[speech-flow.md](speech-flow.md) の「6. 録音のライフサイクル」）は、次のテストで確かめます。通訳の画面のテスト（`InterpreterPage.lifecycle.test.tsx` など）は、実験のスイッチがないときの新しいセッション（`useKeptAudioSession`。マイクを閉じない）の期待です。実験のスイッチがあるときの `useAudioSession`（録音のたびに `getUserMedia` を呼び、録音の後と中断のときに track を `stop()` する）の期待は、`useAudioSession` の単体テストで確かめます。`getUserMedia`、`MediaRecorder`、`SpeechRecognition`、`AudioContext`、`requestAnimationFrame` の代わりは `frontend/src/test/audioMocks.ts` にまとめています。`getUserMedia` と `fetch` は、テストが resolve や reject をするまで終わらず、`MediaRecorder` の `ondataavailable` と `onstop` はテストが起こします。

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
- 止める指示と音量の取得の片付けの後に音量の取得を始めようとしても、`AudioContext` を作らず、`requestAnimationFrame` も頼まないこと（KK4）。今の画面からは起きない経路なので、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります。その後の `onstop` で track を止め、マイク OFF になること（`useAudioSession` の単体テスト。新しいセッションでは、録音の成立の callback の中の中断で、音量の取得と音声認識を始めないことを確かめます）
- 止める指示の後に音声認識を始めようとしても、音声認識の constructor も `start()` も呼ばないこと（KK5）。KK4 と同じく、テストでは録音の成立の callback（`onRecordingStarted`）の中で利用者の停止を呼んで作ります。その後の `onstop` で track を止め、マイク OFF になること（`useAudioSession` の単体テスト）
- 録音の途中の `MediaRecorder` の `onerror` で片付けて、`recording_failed` を表示すること（録音の成立の前の失敗は `recording_start_failed` のまま）
- 利用者の停止で `MediaRecorder` がすでに `inactive`（`onstop` が未着）のときは、`onstop` を待ち、最後のデータを含めて送ること。`onstop` が利用者の停止の前に届いていたときは送らないこと
- 利用者の停止で `MediaRecorder` の `stop()` が例外を出したときは、Backend に送らず、track を止めずに、`recording_failed` を2つの言語で表示し、`idle` に戻ること。診断のログに `recorder_stop_failed:<name>` が残ること
- 利用者の停止の後、`onstop` が見張りの時間（`RECORDER_STOP_TIMEOUT_MS`、10 秒）届かないと、track を止めずに、`recording_failed` を表示し、`idle` に戻ること（`recorder_stop_timeout`）。テストは時間を数字で書かず、定数を参照します。9 秒台で `onstop` が届いた場合は、録音の失敗にならずに送ること。待っている間に中断した場合、古いセッションのタイマーの場合は、タイマーが何もしないこと
- 診断の情報に、`stop()` から `onstop` までの時間（`stopLatencyMs`。`MediaRecorder` がすでに `inactive` のときは、止める指示を記録してから）が残ること。見張りのタイマーで片付けた場合は、`stopTimedOut` と待った時間（`stopWaitedMs`）が残り、後から届いた `onstop` までの時間も残ること
- 録音の途中で track が `ended` になり、`MediaRecorder` が自分で止まると、`recording_failed` を表示して `idle` に戻り、Backend に送らないこと。診断のログに `recorder_stopped_unexpectedly` が残ること。次の録音の開始で、`ended` の track を止めてから `getUserMedia` で取り直すこと。`ended` は `keptMic` の `endedEvents` に記録され、録音のセッションは track に listener を付けないこと（`useAudioSession` の単体テストでは、今までどおり `track_ended` が残り、利用者の停止の後の `ended` と、古いセッションの `ended` では何もしないこと）
- `ready` 以外では読み上げを押せないこと。読み上げの途中に `hidden`、`pagehide`、戻る、外れる、編集が起きたら、今鳴らしている `AudioBufferSourceNode` の `stop()` と `disconnect()` を呼び、後から来た `onended` が画面を変えないこと（`hidden` と `pagehide` では `ready` に戻ること。外れるときは読み上げの `AudioContext` を `close()` すること）。`/api/tts` を待っている間に止めた場合は、後から来た音声を `decodeAudioData` せず、再生しないこと。`<audio>` を使わないこと
- 古いセッションの callback（`getUserMedia` の完了、`ondataavailable`、`onstop`、`onerror`、音声認識の `onresult` と `onend`、`requestAnimationFrame`）が新しいセッションを壊さないこと
- `processing` の間に `hidden` になっても状態は `processing` のままで、国旗を押せず、結果が来たら `ready` になること。戻るや `pagehide` のときは問い合わせを止め、後から結果や失敗が来ても画面に反映しないこと
- 止めた問い合わせ1の結果が遅れて戻っても、画面には問い合わせ2の結果だけが出ること
- `handleSpeak` の守りが働いたときに、`unexpected_active_audio_session_before_tts` が診断のログに残り、片付けが終わってから `/api/tts` を呼ぶこと。読み上げの `AudioContext` を作れないときも、戻る前に同じ記録と片付けをし、`/api/tts` を呼ばないこと（QQ1）
- bfcache から戻ったとき（`pagehide` と `pageshow` の `persisted: true`）に、`starting`、`recording`、`stopping`、`processing` は `idle` に、`ready` と `speaking` は `ready` に直り、録音を始めず（`getUserMedia` も呼ばず）、問い合わせも送らないこと。`pageshow` のときに画面がまだ `processing` でも、記録した状態に直すこと。`persisted: false` の `pageshow` では何もしないこと。bfcache から戻った後に始めたセッション2が、セッション1の古い callback の影響を受けず、同じマイクを使い回すこと
- 診断の情報に、録音ごとの数値（`getUserMedia` の時刻、track の状態、録音の大きさ、音量、音声認識の文字数など）が残り、会話の本文が残らないこと

利用者向けの文言を選んだ2つの言語で表示すること（[ui.md](ui.md)）は、次のテストで確かめます。画面のテストの期待する文言は、既定の日本語と英語の組み合わせでは helper `jaEn` で作ります。エラーのときの `console.warn` は、ログを確かめるテスト以外では `beforeEach` で出力を止めています。

- `getLocalizedMessage` が、2つの言語（`ja` と `en`、`th` と `vi` など）の文言を選んだ順に空行をはさんで連結すること、辞書にない言語では英語になること、選んだ言語が1つだけのときはその言語の文言だけ、1つもないときは英語の文言になること（`messages.test.ts`）
- 13 の文言のすべてのキーに、7言語の空でない文言がそろっていること。`recording_start_failed`、`recording_failed`、`microphone_no_audio` の7言語の文言が決めたとおりであること（日本語だけ句点なし）。読み上げの文言の 500 が `TTS_MAX_CHARS` から作られること。`request_timeout` の英語の文言のアポストロフィが U+2019 であること（`messages.test.ts`）
- 13 の文言のそれぞれが、実際の画面で選んだ2つの言語（主にタイ語とベトナム語。ほかにベトナム語とタイ語の順、韓国語と英語）で表示されること（`InterpreterPage messages in the two selected languages`）
- 対応する文言がない status（502）、ネットワークのエラー（`fetch` の reject）、JSON として読めない応答で汎用のエラーの文言を表示し、`HTTP`、`502`、`Failed to fetch`、Backend の `error` の文字列を表示しないこと
- Frontend の timeout では「うまく翻訳できませんでした」、Backend の 504 では「処理に時間がかかっています」を表示すること
- エラーのとき、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`recording_too_large_before_send`、`TypeError` など）が残り、発話の内容、翻訳の結果、`e.message`、Backend の `error` の文字列が残らないこと（`api.test.ts` と `InterpreterPage.test.tsx`）
- ログの `reason` に入る `code` が `^[a-z0-9_]{1,64}$` に一致しない場合（大文字、空白、65 文字、日本語、改行、空文字）は `invalid` になり、元の文字列がログに出ないこと。一致する場合（`upstream_busy`、許可リストにない `some_new_code`、64 文字）はそのまま出ること。表示の判定は変わらないこと（`api.test.ts`。`/api/tts` は `InterpreterPage.test.tsx`）
- 読み上げで表示する文言がない場合（502、ネットワークのエラー）に、何も表示しないこと

`/api/interpret` の結果表示やエラー処理のテストは、`MediaRecorder` と `navigator.mediaDevices.getUserMedia` を mock し、国旗をタップして録音を開始し、同じ国旗をタップして停止することで `/api/interpret` を呼びます（停止は `handleFlagTap` の `recording` の分岐を通ります。録音中の画面のタップと同じ `stopRecording()` を呼ぶ守りの分岐で、実際の操作の停止（録音中の画面のタップ）は `InterpreterPage.recordingOverlay.test.tsx` で確かめます）（共通の手順は helper `renderAndInterpret` にまとめています）。これらのテストでは `SpeechRecognition` を mock していないため、`transcript` は送られません。`transcript` の送信は、`SpeechRecognition` を mock した国旗タップのテスト 1 件で検証します。

通訳の画面の TTS のテストでは、`frontend/src/test/audioMocks.ts` の `setupAudioContext()` で、`AudioContext` の `resume()`、`decodeAudioData()`、`createBufferSource()`、`destination`、`close()` と、`createBufferSource()` が返す `AudioBufferSourceNode` の `connect()`、`start()`、`stop()`、`disconnect()`、`onended` を差し替え、`/api/tts` の応答は `arrayBuffer()` で返します（`makeTtsOkResponse()`）。`Audio` を置くテスト（`InterpreterPage.lifecycle.test.tsx`、`InterpreterPage.keptMic.test.tsx`、`InterpreterPage.ttsGuard.test.tsx` の QQ1 のテスト）では、`Audio` は再生に使う mock ではなく、`<audio>` の経路に戻っていないこと（呼ばれないこと）を確かめるための spy です。通訳の画面の TTS のテストでは object URL（`URL.createObjectURL`、`URL.revokeObjectURL`）は使いません（object URL と `<audio>` を使うのは、開発用の `MicTestPage` と、実験の `LegacyInterpreterPage` のテストです）。`navigator.mediaDevices`、`AudioContext`、`Audio` などは各テストの前の状態を `beforeEach` で保存し、`afterEach` で元に戻します。`MediaRecorder` と `window.SpeechRecognition` は `afterEach` で削除します。API 呼び出しは `fetch` mock で検証します。

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

1回目の実験（PR #28 のスイッチ。iPhone の Safari で、スイッチごとに Safari を終了して開き直し、3回ずつ話した）の結果：

- 基準、`legacy`、`nometer`：1回目は成功、2回目と3回目は 5 バイト
- `norecog`、`nometer,norecog`：3回とも成功
- 失敗した録音では、`ondataavailable` が1回で 5 バイト、音量の RMS も最初から 0。track は `live`、`muted=false`。音声認識の `end` は、`MediaRecorder.stop()` と track の `stop()` の後に届いている
- 分かったこと：PR #26 の変更は原因ではない（`legacy` でも起きる）。音声認識（`webkitSpeechRecognition`）を使うと、2回目から `getUserMedia` で開いたマイクに音が来なくなる。ただし `norecog` は製品の解決策にならない（話した内容が翻訳より前に出ず、録音中の文字とライブ翻訳がなくなり、固有名詞の質が落ちる）

2回目の実験（PR #28 の後に足したスイッチ `recogfirst`、`recogabort`、`recogdelay`、`recogearly`、`recogonce`）では、**音声認識を使ったまま、2回目からも録音できる止め方や始め方があるか**を確かめます。

3回目の実験（スイッチ `legacykeep`）での方針の変更：

- 今回の改修の本来の目的は、**iPhone で録音のたびに出るマイクの使用のお知らせを減らすこと**です。お知らせは、録音のたびにマイクを閉じて開き直す（毎回の `getUserMedia`）ことが原因です
- これまでの実験で、iPhone では、音声認識（`webkitSpeechRecognition`）とページの `getUserMedia` を同じ録音で使うと、次に `getUserMedia` で開き直したマイクに音が来なくなると分かりました。止め方や始め方を変えても直りませんでした
- Git の履歴を確かめた結果、PR #26 の前（`07f06f0`）の録音のコードは6月末からほぼ変わっておらず、その版（`legacy`）も今日の iPhone では2回目から空になります。「最後の正常な版に戻す」ことはできません
- そのため、原因をさらに細かく追うのはやめ、**本来の目的の方式（マイクを開き直さない）そのものを、最も単純な実装の上で確かめます**。マイクを開き直さなければ、この不具合も起きない可能性があります
- 3回目の実験は、`07f06f0` の通訳の画面（`LegacyInterpreterPage.tsx`）に、マイクの使い回しだけを加えたもの（`legacykeep`）です。今の `useAudioSession` には加えません（変える部分が多く、効果を切り分けにくいため）
- `legacykeep` の2回目からは `getUserMedia` の待ちがないので、`MediaRecorder` の `start()`、`AudioContext` の作成、音声認識の `start()` が、国旗を押した操作の中で同期的に行われます。`legacy` との違いは「マイクを開き直さない」ことと「開始が操作の中で行われる」ことの2つで、この実験ではどちらが効いたかを切り分けられません。成功の後に `useAudioSession` に移すとき（`await` を挟む形になるとき）は、この違いに注意します

4回目の実験（スイッチ `legacymute`）の方針：

- `legacykeep` は iPhone の Safari で 10 回とも成功しました（2回目からお知らせが出ない、録音と音声認識も正常）。ただし、気づいた点が2つありました
  1. 録音を止めても、オレンジ色の表示が消えない（track を止めないので、画面を離れるまで capture が続く）
  2. 読み上げを押しても音が出ない（capture が続いている間に `<audio>` で再生しているため）
- 録音のたびにマイクを閉じると、`legacy` と同じく2回目から録音できなくなります。そこで、閉じずに無効にする形（`enabled = false`）を試します
- 4回目の実験は、`legacykeep` に、録音が止まったら（`onstop` の中で）track を無効にし、次の録音の開始で（`MediaRecorder` を作る前に）有効に戻す動きを加えたもの（`legacymute`）です
- 今後の操作は「国旗をタップでマイク入力モード開始、画面のタップで終了」に変わる予定ですが、**この実験では UI は作りません**（マイクの扱いだけを確かめます）。停止は今までどおり「同じ国旗をもう一度押す」です
- 音量の取得の `AudioContext` の状態は、`running` を前提にしません（無効にした track を有効に戻した後の `AudioContext` の状態は、記録の `audioContextState` と `audioContextFirstTickState` で確かめます）

5回目の実験（スイッチ `recogonly`）の方針：

- 一番大事な条件は、**マイクの使用許可（許可のダイアログと「マイクへのアクセスが許可されています」のお知らせ）を、最初の1回だけにすること**です。あわせて、話していない間は iPhone のオレンジ色の表示が消えていてほしい、という条件があります
- これまでの実験で、`legacykeep`（マイクを開いたまま使い回す）は 10 回とも録音でき、2回目からお知らせも出ませんでしたが、オレンジ色は画面を離れるまで点いたままでした。`legacymute`（track の無効）ではオレンジ色が消えず、マイクを持ったまま `<audio>` で再生すると次の録音が 5 バイトになりました。オレンジ色を確実に消せるのは track の `stop()` だけで、`stop()` した後に開き直すと「2回目から 5 バイト」に戻ります
- 5回目の実験は、`getUserMedia` も録音（`MediaRecorder`）もせず、ブラウザの音声認識だけで文字を取り、その文字を翻訳に送るもの（`recogonly`）です。今の翻訳の経路（音声認識の文字を使う速い経路）をそのまま使うので、原文が翻訳より先に出て、固有名詞も変わりません。`getUserMedia` を使わないので、開き直しによるお知らせと「2回目から 5 バイト」の原因がそもそもありません
- 確かめることは、音声認識を始めるたびに許可やお知らせが出るか、何度も始めて止めても壊れないか、止めた後にオレンジ色が消えるか、`<audio>` の読み上げの後も認識できるか、です
- **この実験では本番の画面は作りません**（録音中の画面、棒グラフ、停止のボタンなどは、方式が決まった後の別の PR で作ります）。停止は今までどおり「同じ国旗をもう一度押す」です。声の大きさは取れないので、本番の棒グラフは「途中の文字が届いている間だけ動き、黙ると止まる」動きにする予定で、そのための値（`result` の時刻の列と `silenceBeforeAutoEndMs`）を記録します

#### 外すもの（原因が分かった後に、外す PR で扱う）

- 消すファイル
  - `frontend/src/experiments.ts`
  - `frontend/src/hooks/experimentTrace.ts`
  - `frontend/src/pages/ExperimentPanel.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.tsx`
  - `frontend/src/recogOnlyText.ts`（5回目の実験）
- 消すテストのファイル
  - `frontend/src/experiments.test.ts`
  - `frontend/src/hooks/useAudioSession.callLog.test.ts`（ただし、外した後も「本番の呼び出しの順番」の守りとして残す価値があるかを、外す PR で判断します。残す場合は、`readExperimentConfig` を使う2つ目のテスト（`?exp=` のとき）を外します）
  - `frontend/src/hooks/useAudioSession.experiments.test.ts`
  - `frontend/src/pages/ExperimentPanel.test.tsx`
  - `frontend/src/hooks/useAudioSession.recognitionVariants.test.ts`（2回目の実験）
  - `frontend/src/pages/ExperimentPanel.recognitionVariants.test.tsx`（2回目の実験）
  - `frontend/src/pages/InterpreterPage.experiments.test.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.test.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.experiments.test.tsx`
  - `frontend/src/pages/LegacyInterpreterPage.keepStream.test.tsx`（3回目の実験）
  - `frontend/src/pages/LegacyInterpreterPage.legacyMute.test.tsx`（4回目の実験）
  - `frontend/src/pages/LegacyInterpreterPage.recogOnly.test.tsx`（5回目の実験）
  - `frontend/src/recogOnlyText.test.ts`（5回目の実験）
  - `frontend/src/App.test.tsx`（`exp` に関わるテストを消した後に残すものがあるかを、外す PR で判断します）
- 戻すもの
  - `frontend/src/hooks/useAudioSession.ts`：`createAudioSession` と `useAudioSession` の `config` の引数、スイッチの分岐（`norecog`、`legacyrecog`、`nometer`、`nodisconnect`、`awaitclose`、`notrackread`、`noendedlistener`、`trace`、2回目の実験の `recogfirst`、`recogabort`、`recogdelay`、`recogearly`、`recogonce`）、2回目の実験のために足したもの（`RECOGNITION_END_TIMEOUT_MS`、`RECOGNITION_END_DELAY_MS`、`RecognitionEndWait`、`Session.recognitionEndWait`、`stopRecognitionFirst`、`waitRecognitionEnd`、`timeOutRecognitionEndWait`、`settleRecognitionEndWait`、`cancelRecognitionEndWait`、`onceRecognition`、`onceRecognitionRunning`、`recordOnce`、`disposeOnceRecognition`、`abort` を分けた `abortSession`、`SpeechRecognition` の型の `abort()`）、`exp` の記録（`Session.exp`、`expDiag`、`perfNow` と、`if (s.exp)` の行のすべて）、`recordPageEvent`、`markTraceListenerOnly`、`AudioDiagnostics.experiment`、`trace` のための型（`SpeechRecognition` の `onstart`、`onaudiostart`、`onaudioend`）、`experiments` と `experimentTrace` の import。`stop` の後半を分けた `stopRecorder` と `startStopWatchdog` を残すか戻すかは、外す PR で判断します
  - `frontend/src/hooks/useKeptAudioSession.ts`（PR A）：`useInterpreterAudioSession` の実験のスイッチの分岐（`AUDIO_SESSION_EXPERIMENTS`、`usesAudioSessionExperiment`、`createAudioSession` を使う分岐）。外した後は `useKeptAudioSession` だけを使い、`useAudioSession.ts` は、`useKeptAudioSession.ts` が import している型と `RECORDER_STOP_TIMEOUT_MS` を移してから消します（`useAudioSession` の単体テスト4ファイルも消します）。`recordPageEvent` と `markTraceListenerOnly`（何もしない）も外します。`getDiagnostics()` の `keptMic`（`KeptAudioDiagnostics`）は、診断の表示（「コピー」の JSON）を外すときに、残すかを判断します（`keptMic.ts` の `getUserMediaCalls()` と `endedEvents()` も同じ）
  - `frontend/src/hooks/useKeptAudioSession.test.ts` と `frontend/src/pages/InterpreterPage.keptMic.test.tsx`（PR A）：スイッチがあるときに `useAudioSession` を使うことを確かめるテスト（`useInterpreterAudioSession`、`lists every useAudioSession switch`、`?exp=trace` を付けたテスト。スイッチのときに `keptMic` の診断が入らないことのテストも含む）
  - `frontend/src/pages/InterpreterPage.tsx`：`experiment` の props、`experimentRef`、`useInterpreterAudioSession` に渡す `experiment`、ページの listener の分岐（`trace` の記録、`nolifecycle`、記録だけの listener）と `audioSessionRef`、`ExperimentPanel` とその import
  - `frontend/src/App.tsx`：`readExperimentConfig` で読む `experiment`、`LegacyInterpreterPage` への切り替えとその import、`InterpreterPage` に渡す `experiment`
  - `frontend/src/test/audioMocks.ts`：2回目の実験で足した、音声認識の代わりの `abort`（`FakeRecognition.abort`）
  - 3回目の実験の `legacykeep` で足したもの（上の「消すファイル」と「消すテストのファイル」に含まれるものも、漏れの確かめのために並べます）
    - `experiments.ts`：`EXPERIMENT_NAMES` の `legacykeep`、`ExperimentConfig.legacyKeep`、`DEFAULT_EXPERIMENT_CONFIG.legacyKeep`、`resolveExperimentConfig` の `legacykeep` の分岐とコメント、`legacyKeep: on('legacykeep')`
    - `App.tsx`：`experiment.legacyKeep` の条件とコメント
    - `LegacyInterpreterPage.tsx`：冒頭のコメントの2行（`legacykeep` の説明）、`MAX_LEGACY_KEEP_RECORDINGS` と記録の上限の切り替え（`maxRecordings`）、`getUserMediaCallsRef`、`keepStartingRef`（`getUserMedia` を待つ間の2回目の操作の守り）、`keepUnmountedRef` とそれを付ける `useEffect`（待つ間に画面が外れたときの守り）、`startRecording` の使い回しの分岐（`keepTrackStates`、`streamReused`、古い track の `stop()`）、`onstop` の `legacykeep` の条件、`keep` の変数と、`AudioContext` の状態の記録（`audioContextState`、`audioContextFirstTickState`、`catch` の `audioContextError`）、tick の中の RMS の記録（`rms` の変数、`keepFirstTick`、`keep` の行）、`callInterpretApi` の `transcriptSent` の記録、`read` の `keepStream` の写し
    - `ExperimentPanel.tsx`：`LegacyRecording.keepStream`、`LegacyKeepStream`（`trackStates`、RMS、`AudioContext` の状態、`transcriptSent` の項目）、`legacy` の表示の見出し（`legacykeep`）と、マイク、track、RMS、`AudioContext`、音声認識の文字の表示
    - `App.test.tsx`：足した2件（`exp=legacykeep`、`exp=legacy,legacykeep`）
    - `experiments.test.ts`：`describe('resolveExperimentConfig: legacykeep')`
  - 4回目の実験の `legacymute` で足したもの（上の「消すファイル」と「消すテストのファイル」に含まれるものも、漏れの確かめのために並べます）
    - `experiments.ts`：`EXPERIMENT_NAMES` の `legacymute`、`ExperimentConfig.legacyMute` とそのコメント、`DEFAULT_EXPERIMENT_CONFIG.legacyMute`、`resolveExperimentConfig` の `legacymute` の分岐とコメント、`legacyKeep: on('legacykeep') || on('legacymute')` の `legacymute` の部分とコメント、`legacyMute: on('legacymute')`
    - `LegacyInterpreterPage.tsx`：冒頭のコメントの2行（`legacymute` の説明）、`MAX_LEGACY_MUTE_TTS_PLAYS`、`describeTrack`、`muteRecordingCountRef`、`muteTtsPlaysRef`、`startRecording` の `muteTrackStatesAfterEnable` と、使い回すときに track を有効に戻す分岐、`getUserMedia` の後の記録、`keepStream` の `recordingNo`、`trackStatesAfterEnable`、`trackStatesAfterDisable` の記録、`onstop` の track を無効にする分岐、`startRecording` の `muteRecorder` と `muteAudioCtx`、`replacedByOther` と、それを使う `ondataavailable` と `onstop` の行、`startRecording` の `catch` の `legacymute` の分岐（`MediaRecorder` の停止、波紋と `AudioContext` の片付け（`audioContextRef` に入れる前の例外の後でも `muteAudioCtx` を閉じる行を含む）、track を無効に戻す行）、`handleSpeak` の `legacymute` の分岐（読み上げの記録と、`onended`、`onerror`、`play()` の結果の記録。`else` の `await audio.play()` は元の1行に戻す）、`read` の `trackStatesAfterEnable`、`trackStatesAfterDisable`、`ttsPlays` の写し
    - `ExperimentPanel.tsx`：`LegacyKeepStream` の `recordingNo`、`trackStatesAfterEnable`、`trackStatesAfterDisable`、`LegacyTtsPlay`、`ExperimentSnapshot` の `ttsPlays`、`SHOWN_TTS_PLAYS`、`legacy` の表示の見出し（`legacymute`）と、録音の番号と track の有効と無効の表示、`TtsPlaysView`
    - `App.test.tsx`：足した2件（`exp=legacymute`、`exp=legacy,legacykeep,legacymute`）
    - `experiments.test.ts`：`describe('resolveExperimentConfig: legacymute')`
    - `ExperimentPanel.test.tsx`：`describe('ExperimentPanel with legacymute')`
  - 5回目の実験の `recogonly` で足したもの（上の「消すファイル」と「消すテストのファイル」に含まれるものも、漏れの確かめのために並べます）
    - `experiments.ts`：`EXPERIMENT_NAMES` の `recogonly`、`ExperimentConfig.recogOnly` とそのコメント、`DEFAULT_EXPERIMENT_CONFIG.recogOnly`、`resolveExperimentConfig` の `recogonly` の分岐とコメント、`recogOnly: on('recogonly')`
    - `App.tsx`：`experiment.recogOnly` の条件と、コメントの「recogonly も同じ部品を使う」
    - `recogOnlyText.ts`：`joinRecognitionSegments` と `NO_SEPARATOR_LANGS`（ファイルごと消す）
    - `LegacyInterpreterPage.tsx`：冒頭のコメントの2行（`recogonly` の説明）、`recogOnlyText` と `RecogOnly*` の型の import、`MAX_RECOG_ONLY_RECORDINGS`、`MAX_RECOG_ONLY_TTS_PLAYS`、`MAX_RECOG_ONLY_EVENTS`、`MAX_RECOG_ONLY_AUTO_RESTARTS`、`RECOG_ONLY_END_TIMEOUT_MS`、`recogErrorName`、ローカルの型を広げた部分（`SpeechRecognitionErrorEvent`、`SpeechRecognition` の `onaudiostart`、`onsoundstart`、`onspeechstart`、`onspeechend`、`onsoundend`、`onaudioend`、`onerror` の引数、`abort()`。`onerror` は元の `(() => void) | null` に戻す）、`RecogOnlyUtterance`、`pushRecogEvent`、`recogInterpretError`、`recogUtteranceRef`、`recogRecordingCountRef`、`recogDiagRef`、`callInterpretApi` の記録先の引数（`recogRecord`）と、それを使う行（先頭の確認の `skipped_busy`、`transcriptSent`、`language_mismatch`、`ok`、`catch` の行。先頭の確認と `language_mismatch` の分岐は元の1行に戻す）、`finishUtterance`、`interpretUtterance`、`startRecogOnly`（部品の constructor の例外の `try` と `ctor-error` の記録を含む）、`stopRecogOnly`、`finishUtteranceRef` とそれを入れる `useEffect`、画面が外れるときに `unmount` で終える `useEffect`、`handleFlagTap` の `experiment.recogOnly` の分岐（終了と開始。元の `stopRecording()` と `startRecording(...)` の1行に戻す）、`handleSpeak` の `recogonly` の分岐（`RecogOnlyTtsPlay` の記録。`else if (experiment.legacyMute)` は元の `if` に戻す）、`read` の `recogonly` のスナップショット（`experiment.recogOnly ? ... : ` の部分）
    - `ExperimentPanel.tsx`：`RecogOnlyEventType`、`RecogOnlyEvent`、`RecogOnlyFinishReason`（`ctor-error` を含む）、`RecogOnlyRecording`（`constructorError` を含む）、`RecogOnlyTtsPlay`、`RecogOnlyDiagnostics`、`ExperimentSnapshot` の `kind: 'recogonly'`、`SnapshotView` の `recogonly` の分岐、`RecogOnlyView`
    - `audioMocks.ts`：`FakeRecognition` の `onaudiostart`、`onsoundstart`、`onspeechstart`、`onspeechend`、`onsoundend`、`onaudioend`、`setupSpeechRecognition` の `throwOnStart` の option とそのコメント（`start` は元の `vi.fn()` に戻す）
    - `App.test.tsx`：足した2件（`exp=recogonly`、`exp=legacymute,recogonly`）
    - `experiments.test.ts`：`describe('resolveExperimentConfig: recogonly')`
    - `backend/main_handlers_test.go`：`TestInterpretHandler_TranscriptPath_EmptyAudio`（Backend の動きは変えていません。0 バイトの `audio` と `transcript` の組み合わせを、本番でも使い続けるなら残します。外す PR で判断します）
- ドキュメント
  - `docs/testing.md`：「3. Frontend テスト」のテストファイルの表の、実験の PR で加えた行（上の「消すテストのファイル」の 14 ファイルの行。表では 14 行）と、この節（「切り分けの実験のスイッチ」）そのもの
  - `docs/speech-flow.md`：6.9（診断の情報）の終わりの、実験のスイッチの段落

#### PR A（マイクを開いたまま使い回す）の後の実機の確認

PR A で、本番の通訳の画面（`?exp` なし）を、マイクを開いたまま使い回し、読み上げを `AudioContext` で鳴らし、マイクの音が来ないときに知らせる形にしました（[speech-flow.md](speech-flow.md) の 6.1、8.1、9）。この確認が成功してから、次の PR（新しい操作の画面。PR B）に進みます。

iPhone の Safari と Chrome のそれぞれで、ブラウザを終了してから開き、次を行います。診断の「コピー」の JSON を取るため、`https://gotalk.chiemaru.com/?exp=`（`exp` は空。実験のスイッチはなしで、本番と同じ新しいセッションを使い、診断の表示だけが出ます）で行います。

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
- 3 と 4 で、録音できたか、できなかったときに `microphone_no_audio`（「マイクの音を受け取れませんでした。ブラウザを一度終了してから、開き直してください」）が出たかを記録する（検出が働くことが条件。録音できるかどうかは iPhone の動きなので条件にしない）
- 読み上げの音量：ふつうに聞こえることが条件。小さい（受話口から鳴る、など）ときは失敗とし、扱いを利用者が決める（マイクを開いたまま鳴らすと、iPhone が音の出口を変えることがあるため）
- 診断：「コピー」の JSON の `diagnostics.events` で、正常に鳴り終わった読み上げについて `tts_ended_timeout` が 0 件であること（見張りのタイマーが誤って働いていないこと）。`no_audio_detected` の有無も確かめる

判断の仕方：成功なら PR B に進む。1 か 2 が失敗なら、PR A の動きを見直す（PR B に進まない）。

#### PR B（録音中の画面）の実機の確認

PR B で、録音中にグレーの画面（録音中の画面。[ui.md](ui.md) の「録音中の画面」）を出し、画面のタップで話し終われるようにしました。読み上げの時間の記録（[speech-flow.md](speech-flow.md) の「9. TTS」の「読み上げの時間の記録」）も足しました。マージの前に、ステージング（`https://staging.gotalk.chiemaru.com/?exp=`）で、iPhone の Safari で確かめます。手順ごとに、期待値を先に伝えてから行います。

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
   - **言語の選択に戻る前に取る**（診断は通訳の画面ごとに作られ、言語の選択に戻ると空から始まるため）
   - `diagnostics.events` の `tts_tap`、`tts_response:status=…`、`tts_downloaded:bytes=…`、`tts_decoded:ms=…`、`tts_started` の `at` の差で、押してから応答まで（OpenAI と通信）、ダウンロード、変換、再生の開始までの時間を分ける。同じ時刻の Backend のログの `tts: runes=… bytes=… openai_ms=…` と合わせて、OpenAI の時間と通信の時間を分ける

棒グラフの仕様：棒グラフは、音声認識の途中の文字が更新されている間だけ動きます。声そのものを検知しているのではないので、話していても認識の文字が更新されなければ止まります（音声認識が遅れたとき、聞き取れなかったときなど）。2 で棒が止まっても、文字が更新されていなければ期待どおりです。

#### GOTALK-6（話さなくても文字を入力して翻訳する）の実機の確認

GOTALK-6 で、原文のカードの鉛筆のボタンを最初から押せるようにし、話さなくても文字を打って翻訳できるようにしました（[ui.md](ui.md) の「原文の入力と編集」）。マージの前に、ステージング（`https://staging.gotalk.chiemaru.com/`）で、iPhone の Safari と Chrome のそれぞれで確かめます。手順ごとに、期待値を先に伝えてから行います。

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
10. `?exp=` を付けて開き（`https://staging.gotalk.chiemaru.com/?exp=`）、鉛筆のボタンで文字を打ち、画面の下の「コピー」の上をタップする
    - 期待値：確定して翻訳が出る。コピーは起きない

#### GOTALK-7（カメラで撮った文字を翻訳する）の実機の確認

GOTALK-7 で、原文のカードの左にカメラのボタンを足し、写真の中の文字を行ごとに訳せるようにしました（[ui.md](ui.md) の「8. 写真の翻訳」）。マージの前に、ステージング（`https://staging.gotalk.chiemaru.com/`）で、iPhone の Safari と Chrome のそれぞれで、次の写真を試します。ステージングは `OPENAI_VISION_MODEL` と `OPENAI_VISION_REASONING_EFFORT` を Compose から渡さないので、既定の値（`gpt-6-luna`、`none`）で動きます。

- 写真を撮る、写真ライブラリ、スクリーンショット、横向きの写真、HEIC、文字のない写真、文字の多い写真
- 上限の近く（1,032,192 バイト）の JPEG を multipart で送って、nginx を通ること（Shin の Mac から `curl` で確かめる。手順は Claude.ai が用意する）
- 費用は、OpenAI のステージングの Project の使用量で確かめる

#### スイッチと診断

- 指定：URL の query の `exp` で指定します（例：`?exp=norecog`、`?exp=nometer,norecog`）。hash は使いません（`#mic-test` などと衝突させないため）。画面を読み込んだときに一度だけ読み取り、途中で URL を変えても反映しません。`?exp=` の空の指定でも、実験のモードになります。名前は小文字で書きます（知らない名前は無視し、診断の表示に出します）
- **`useAudioSession` のスイッチがないとき（URL に `exp` がないときと、`?exp=` の空の指定のとき）は、PR A の新しいセッション（`useKeptAudioSession`。マイクを閉じない）を使います。** `useAudioSession` のスイッチ（下の表の `norecog` から `recogonce` まで）が1つでもあるときは、PR A の前の `useAudioSession` を使います（`useInterpreterAudioSession`）。`exp` がないときは、診断の表示を描画せず、`performance.now()` を使った実験の記録もしません
- `useAudioSession.callLog.test.ts` は、`useAudioSession` に、スイッチがないときの設定を渡したときに、ブラウザの API の呼び出しの順番と回数がスイッチを入れる前（`782635e`）と同じであることを確かめるもので、本番の経路（新しいセッション）は確かめていません。`useAudioSession` の中の各スイッチの分岐は、前のコードをそのまま条件の中に置く形にしています

| 名前 | 動き |
| --- | --- |
| （空。`?exp=`） | `exp` がないときと同じ動き（新しいセッション。`useKeptAudioSession`）。診断の表示を出す。「コピー」の JSON には、`diagnostics.sessions`、`diagnostics.events`、`diagnostics.keptMic` が入り、`diagnostics.experiment`（下の passive の診断）は入らない。PR A の後の実機の確認は、この指定で行う |
| `legacy` | PR #26 の前（`07f06f0`）の通訳の画面を、別の部品（`LegacyInterpreterPage`）としてそのまま使う。`useAudioSession` は使わない |
| `legacykeep` | （3回目の実験）`legacy` と同じ部品（`LegacyInterpreterPage`）で、マイク（`MediaStream` と track）だけを閉じずに使い回す。録音の開始で、持っている stream に track が1つ以上あり、どれも `ended` でなければ、`getUserMedia` を呼ばずにその stream を使う。持っていないとき、track がないとき、`ended` の track があるときは、古い track をすべて `stop()` してから `getUserMedia` を呼ぶ（判定に使うのは `readyState` だけで、`muted` と `enabled` は記録だけ）。`getUserMedia` を待つ間の2回目の操作では何もしない。待つ間に画面が外れたときは、解けた stream の track をすべて止め、録音を始めない。録音の停止の後（`onstop`）は、track の `stop()` を呼ばず、stream も手放さない。画面が外れるとき（言語の選択の画面に戻るときなど）は、今までどおり track を止める。**画面が隠れても（ほかのアプリやタブに切り替えても）、画面が外れるまでマイクを持ち続ける**（ページの出来事の扱いは `legacy` と同じで、見直しは成功の後に行う）。`MediaRecorder`、音声認識、音量の取得の `AudioContext` は、今までどおり録音ごとに作って止める（`AudioContext` は使い回す stream から作る）。翻訳、固有名詞の保護、読み上げ（`<audio>`）、ページの出来事の扱いは `legacy` と同じ |
| `legacymute` | （4回目の実験）`legacykeep` に、`onstop` での track の無効と、録音の開始のときの有効を加えたもの（`legacyKeep` も true になり、`legacykeep` のすべての動きを使う）。`MediaRecorder` が最後のデータを出し終わった後（`onstop` の中。利用者の停止でない `onstop` でも）に、持っている stream の track をすべて `enabled = false` にする（`stop()` はせず、stream も手放さない。`MediaRecorder.stop()` の前には無効にしない）。次の録音の開始で使い回すと決めた直後、`MediaRecorder` を作る前に、track をすべて `enabled = true` に戻す（`await` は挟まない）。`getUserMedia` を呼んだときは、新しい track は有効のまま。使い回すかの判定は `legacykeep` と同じく `readyState` だけで、`enabled` が false であることを理由に `getUserMedia` をやり直さない。有効に戻した後に開始の途中で失敗した（`startRecording` の `catch` に入った）ときは、その開始で始めた `MediaRecorder` を止め（翻訳には送らない）、波紋とその開始で作った `AudioContext` を片付け（`audioContextRef` に入れる前の例外の後でも閉じる）、track を無効に戻す。画面が外れるときは、今までどおり track を `stop()` する。読み上げ（`<audio>`）の再生の仕方は変えず、記録だけを足す |
| `recogonly` | （5回目の実験）`legacy` と同じ部品（`LegacyInterpreterPage`）で、`getUserMedia`、`MediaRecorder`、音量の取得の `AudioContext`（波紋）を一切使わず、ブラウザの音声認識だけで録音の開始と終了を行う。国旗の1回目のタップの処理の中で、`await` を挟まずに、発話ごとに音声認識の部品を作り（言語はタップした国旗、`continuous` と `interimResults` は true）、`start()` を呼ぶ。部品がないとき（`ctor-missing`）、部品の constructor（`new RecognitionCtor()`）の例外（`ctor-error`）、最初の `start()` の例外（`start-error`）では、`recording_start_failed` を出して `idle` に戻る（`ctor-missing` と `ctor-error` は、発話の状態を作らず、`finishUtterance` を通さずに記録に直接書く）。利用者が終了する前に音声認識が自動で終わったとき（`onend`）は、そこまでの文字（途中の文字も含む）を確定し、同じ部品の `start()` を呼び直す（1回の発話で 20 回まで。21 回目が必要になったとき（`restart-limit`）と、始め直しの `start()` の例外（`restart-start-error`）では、そこまでの文字で翻訳に進む）。前の文字と始め直した後の文字は `joinRecognitionSegments` でつなぐ（`ja`、`zh-CN`、`zh-TW` は区切りなし、`en`、`ko`、`th`、`vi` は半角の空白を1つ）。国旗の2回目のタップで、その場で `processing` にし、`stop()` を呼び、最後の `onend` で翻訳に進む（`user-stop`）。2000ms 経っても `onend` が来ないときは、そこまでの文字で翻訳に進んでから `abort()` を呼ぶ（`end-timeout`）。`onerror` の `not-allowed` と `service-not-allowed` では、`abort()` を呼び、翻訳には送らず、`microphone_denied` を出して `idle` に戻る。画面が外れるときは `abort()` を呼ぶ（`unmount`）。翻訳には、0 バイトの `audio`（`recording.webm`）と、組み立てた文字（前後の空白を除いたもの）を `transcript` として送る（Backend の速い経路。Whisper は呼ばない）。文字が空なら送らず、`recording_failed` を出す。終了はすべて `finishUtterance` を通し、最初の1回だけが効く。翻訳の結果の表示、ライブ翻訳、読み上げ（`<audio>`）は `legacy` と同じで、読み上げは記録だけを足す |
| `norecog` | 音声認識を一切作らない（constructor も呼ばない） |
| `legacyrecog` | 音声認識の部分だけ、PR #26 の前の方式にする：`start()` が成功した後に ref に入れ、`onend` では `MediaRecorder` が `recording` なら始め直す（画面の状態は見ない）。`07f06f0` との違いは次のとおりです：`onend` の始め直しは止める指示の前だけ、見る `MediaRecorder` はそのセッションのもの（片付けの後は空）、`start()` の例外は今の版と同じく `recognition_failed` として記録する、`onresult` は今の版のまま。理由は、止めた後に音声認識が残ると実験の結果を汚すため（`awaitclose` と組み合わせると、`close()` を待つ間も `recording` のままになる）で、`07f06f0` では止める指示と `MediaRecorder.stop()` が同じ同期の処理の中にあったので、意味は同じです |
| `nometer` | 音量の取得（`AudioContext`、`createMediaStreamSource`、analyser、`requestAnimationFrame`）を一切使わない。波紋は動かない |
| `nodisconnect` | `sourceNode.disconnect()` を呼ばず、`AudioContext.close()` だけにする（利用者の停止と中断の片付けの両方） |
| `awaitclose` | 利用者の停止で、`AudioContext.close()` の完了を待ってから `MediaRecorder.stop()` を呼ぶ。待っている間に中断されたときは、`stop()` を呼ばずに中断の片付けに任せる。見張りのタイマーは、待つ前に始める |
| `notrackread` | `getAudioTracks()` は呼ぶが、track の `readyState`、`enabled`、`muted` を読まず、`live` でないときの失敗の判定もしない（track がないときの失敗の判定は残す） |
| `noendedlistener` | track に `ended` の listener を付けない |
| `nolifecycle` | 通訳の画面で、`visibilitychange`、`pagehide`、`pageshow` の listener を付けない |
| `trace` | extended の記録を有効にする |
| `recogfirst` | （2回目の実験）利用者の停止で、音声認識の `stop()` を呼んだ後、音声認識の `end` が届くのを待ってから `MediaRecorder.stop()` を呼ぶ。`error`（`aborted` など）は記録するだけで、完了とはしない。`end` が 1.5 秒以内に届かないときは見切って `MediaRecorder.stop()` を呼び、診断に `recognitionEndTimedOut` を残す（見切った後に届いた `end` は記録だけ）。音量の取得の片付け（`disconnect` と `close()` の開始）は、今と同じく `MediaRecorder.stop()` の前（`end` を待つ前）。待っている間に中断したときは、待ちを無効にし、タイマーを取り消し、`MediaRecorder.stop()` を呼ばずに中断の片付けに任せる。見張りのタイマー（10 秒）は待つ前に始める（1.5 秒の見切りとは別）。音声認識がない（作れなかった、`start()` が失敗した）ときは待たない |
| `recogabort` | （2回目の実験）音声認識の `stop()` の代わりに `abort()` を呼ぶ（利用者の停止と、中断の片付けの両方） |
| `recogdelay` | （2回目の実験）`recogfirst` と一緒のときだけ効く。`end` が届いた後、さらに 500 ミリ秒待ってから `MediaRecorder.stop()` を呼ぶ |
| `recogearly` | （2回目の実験）録音の開始で、音声認識を `getUserMedia` の前に始める（音声認識の `start()` → `getUserMedia` → `MediaRecorder.start()`）。録音の成立の後には始めない。録音の成立までの失敗や中断（`getUserMedia` の失敗、待つ間の中断、track がない、`live` でない、`MediaRecorder` の作成や `start()` の失敗）では、片付けで音声認識を止める（`recogabort` があれば `abort()`） |
| `recogonce` | （2回目の実験）音声認識の部品を、画面（`createAudioSession`）で1つだけ作り（最初の録音のときに作る）、録音ごとに `start()` と `stop()` を繰り返す。`onresult`、`onerror`、`onend` は `start()` のたびに、そのときのセッションに結び付けたものに付け替え、結び付けたセッションが今のセッションでないときは記録だけにする。**前の実行の `end` が届いていないとき（`start()` の成功の後、まだ `onend` が来ていないとき）は、その録音では handler の付け替えも `start()` もせず、音声認識なしで録音を続け、飛ばしたことを記録する（`recognition_once_previous_end_pending` のログと `recognitionOnce.skippedPendingEnd`）。** `end` は1回の実行の最後の出来事なので、こうすると前の実行の遅れた出来事が次のセッションのものとして配られない。`end` が届かないまま残ると、以後の録音はすべて飛ばされる（それ自体が実験の結果）。画面が外れるとき（`unmount`）は、セッションの片付けで部品を止めた後に、部品を手放す（前の実行が終わっていないかの記録も初期の値に戻す） |

組み合わせ：

- `legacy` は単独です。ほかの名前（`trace` も）と一緒に指定したときは `legacy` だけを使い、ほかは効きません
- `legacykeep` も単独です。ほかの名前（`trace` も）と一緒に指定したときは `legacykeep` だけを使い、ほかは効きません。`legacy` と一緒に指定したときは `legacykeep` を使い、`legacy` は効きません（`legacykeep` は `legacy` にマイクの使い回しを加えたものなので）
- `legacymute` も単独です。ほかの名前（`trace` も）と一緒に指定したときは `legacymute` だけを使い、ほかは効きません。`legacy` や `legacykeep` と一緒に指定したときは `legacymute` を使い、`legacy` と `legacykeep` は効きません（`legacymute` は `legacykeep` に track の無効と有効を加えたものなので）
- `recogonly` も単独です。ほかの名前（`legacy`、`legacykeep`、`legacymute`、`trace` も）と一緒に指定したときは `recogonly` だけを使い、ほかは効きません（理由は「recogonly と組み合わせない」）。`legacymute`、`legacykeep`、`legacy` より優先します
- `norecog` は、音声認識を使うスイッチ（`legacyrecog`、`recogfirst`、`recogabort`、`recogdelay`、`recogearly`、`recogonce`）より優先します
- `nometer` は `nodisconnect` と `awaitclose` より優先します
- `nodisconnect` と `awaitclose` は組み合わせて使えます
- `recogdelay` は、`recogfirst` がないときは効きません
- `recogfirst` と `recogabort` は組み合わせて使えます（`abort()` → `end` を待つ → `MediaRecorder.stop()`）
- `recogfirst` と `awaitclose` を一緒に指定したときは、両方を待ちます（`end` を待つ → `close()` の完了を待つ → `MediaRecorder.stop()`）
- `recogfirst`、`recogabort`、`recogearly`、`recogonce` は、`legacyrecog` より優先します（`legacyrecog` は効きません）。2回目の実験は、今の版の音声認識の扱いを変えて調べるもので、PR #26 の前の方式（`legacyrecog`）と混ぜると、どちらの変更で結果が変わったかが分からなくなるためです。`recogdelay` だけを `legacyrecog` と一緒に指定したときは、`recogdelay` が効かず、`legacyrecog` が効きます
- 2回目の実験のスイッチどうし（`recogfirst`、`recogabort`、`recogdelay`、`recogearly`、`recogonce`）は、上の `recogdelay` の条件のほかは、組み合わせて使えます

診断：

- passive（`useAudioSession` のスイッチがあるとき。`?exp=` の空の指定では新しいセッションを使うので、この記録はなく、`diagnostics.experiment` は入りません）：新しい listener を足さず、自分のコードの中の時刻と、もともとある出来事の handler の中の値だけを記録します。`getDiagnostics()` の値（`notrackread` のときは track の状態を含めない）、スイッチの指定（`raw`、`requested`、`ignored`、`inactive`、`effective`）、`AudioContext` の作成、`createMediaStreamSource` と `connect`、`disconnect`、`close()` を呼んだ時刻と完了の時刻、`getUserMedia` を呼んだ時刻、`MediaRecorder` の `start()` と `stop()` を呼んだ時刻、`ondataavailable` の時刻と大きさ（回ごと）、`onstop` の時刻、最終の `Blob` の大きさ、音量の最初の値と最初の 0 でない値の時刻、音声認識の `start()` と `stop()` を呼んだ時刻と `onresult`（文字数だけ）、`onerror`（エラーの文字列）、`onend` の時刻です。認識した本文は記録しません
- 時刻は、新しく足すものはすべて `performance.now()` です（`requestAnimationFrame` の timestamp と同じ基準）。既存の診断の時刻（`Date.now()`）は変えず、セッションの開始のときに `Date.now()` と `performance.now()` の組を1つだけ残します
- extended（`trace` のとき）：もともと handler があるもの（track の `ended`、`visibilitychange`、`pagehide`、`pageshow`）は、既存の handler の中で記録します。新しい listener を付けるのは、今の版にない出来事（track の `mute` と `unmute`、`MediaRecorder` の `onstart`、音声認識の `onstart`、`onaudiostart`、`onaudioend`）だけです。`nolifecycle` と一緒のときは、記録のためだけの listener を付け（中断の片付けなどはしない）、`traceListenerOnly: true` を残します。`noendedlistener` と一緒のときは、`ended` を記録せず、`endedNotRecorded` にその旨を残します
- 2回目の実験の passive の診断（新しい listener は足さない）：
  - `recogfirst`：セッションごとの `recognitionEndWait` に、待ち始めた時刻（`waitStartedAt`）、`end` が届いた時刻（`endAt`）、1.5 秒で見切ったか（`recognitionEndTimedOut`）と見切った時刻（`timedOutAt`）、見切った後に届いた `end` の時刻（`lateEndAt`）、待っている間の中断の時刻（`cancelledAt`）、音声認識がなくて待たなかったか（`noRecognition`）。見張りのタイマーの見切りは、今までどおり `recorder.stopTimedOut` で、別の項目です
  - `recogdelay`：`recognitionEndWait.delayEndedAt`（500 ミリ秒の待ちの終わり）
  - `recogabort`：音声認識の出来事に `abort_call`（`stop_call` と区別する）
  - `recogearly`：音声認識の `start_call` の時刻と `getUserMediaCalledAt` の並び、セッションごとの `recogEarly.stoppedBeforeRecordingAt`（録音の成立の前に音声認識を止めた時刻）
  - `recogonce`：画面の単位の `recognitionOnce` に、部品を作った回数（`createdCount`。1 のはず）、手放した時刻（`disposedAt`）、出来事（`start_call`、`result`、`error`、`end`）ごとの、結び付けたセッションの番号（`boundSessionId`）とそのときの有効なセッションの番号（`activeSessionId`）。2つが一致しない出来事は、表示で「不一致」と出します。前の実行の `end` が届いていなかったので音声認識を始めなかった録音（`skippedPendingEnd`。セッションの番号と時刻）も、表示に出します
  - 音声認識の `audioend` などは、今までどおり `trace` のときだけ記録します。`recogfirst` の待ちには `audioend` を使わず、`end` だけで待ちます
- `trace` のときは、ページの出来事（`visibilitychange`、`pagehide`、`pageshow`）の handler の中で `document.visibilityState` を読みます（`trace` を付けないときは、`pagehide` と `pageshow` の handler では読みません。`visibilitychange` の handler は、もともと読んでいます）
- `legacy` のとき：PR #26 の前のコードにもともとある `ondataavailable` と `onstop` の中での値と、`start()` と `stop()` を呼んだ箇所の時刻だけを記録します（`ondataavailable` の回数と大きさ、`onstop` で作る最終の `Blob` の大きさと `type`（`blobType`）、`start()` と `stop()` の時刻）。`MediaRecorder` の property（`mimeType` など）、track の読み取り、track の listener、`AudioContext` の診断、ページの出来事の listener は足していません
- `legacykeep` のとき：`legacy` の記録に加えて、録音ごとの `keepStream` に、その録音で stream を使い回したか（`streamReused`。`false` は `getUserMedia` を呼んだ）、画面を開いてから `getUserMedia` を呼んだ回数の合計（`getUserMediaCalls`）、使い回すかを決めたときの track の状態（`trackStates`。`readyState/enabled/muted` の形で、今の通訳の画面の診断の表示と同じ。例：`live/enabled/unmuted`。持っていないときは空）、波紋の表示の tick（もともとある `requestAnimationFrame`）の中で取った RMS の最大値（`rmsMax`）と、0 でない値を取った回数（`rmsNonZeroSamples`）、tick の回数（`rmsSamples`）、音量の取得の `AudioContext` の作った直後の `state`（`audioContextState`）と最初の tick での `state`（`audioContextFirstTickState`。tick が回らなかったときは `null`）、作成から analyser までのつなぎで出た例外の `name`（`audioContextError`。出なかったときは `null`。`audioContextError` があり、`audioContextState` が `null` なら、`AudioContext` の作成の例外です。`audioContextState` に値があれば、作成の後（`createMediaStreamSource`、analyser、つなぎ）の例外です。作成の後の例外のときは、その録音の `AudioContext` は閉じられません（`legacy` からある動きで、この実験では変えていません）。`legacykeep` では録音のたびに同じ例外が起き得るので、閉じられない `AudioContext` が増え、後の録音の `audioContextError` の内容が変わることがあります。`audioContextError` が続く場合は、最初の録音の例外を見て判断します）、音声認識の文字を付けて Backend に送ったか（`transcriptSent`。付けなかったときは `false`、Backend に送らなかった録音は `null`）を記録します。新しい timer や listener は足していません。track の状態（`readyState`、`enabled`、`muted`）は `legacykeep` のときだけ読みます（`legacy` のときは読みません）。記録は、`legacy` は直近の 10 件、`legacykeep` は直近の 20 件を残します（表示は直近の5回分で、「コピー」の JSON にはすべて入ります）
- `legacymute` のとき：`legacykeep` の記録（記録の上限の 20 件も同じ）に加えて、次を記録します。`legacykeep` のときは、これらの項目を持ちません
  - 録音ごとの `keepStream` に、画面を開いてから何回目の録音か（`recordingNo`。1から。録音の記録が成立したとき（`MediaRecorder` を作れたとき）に数える）、録音の開始で track を有効に戻した直後の状態（`trackStatesAfterEnable`。`getUserMedia` を呼んだときは、新しい track の状態）、`onstop` で track を無効にした直後の状態（`trackStatesAfterDisable`。`onstop` が来るまでは空の配列）。書き方は `trackStates` と同じ `readyState/enabled/muted` です。2回目からの `trackStates`（使い回すかを決めたときの状態）は、前の録音の後に無効にしたので `live/disabled/...` になります
  - 読み上げの記録（`ttsPlays`。画面ごとに直近の 10 件）：`handleSpeak` で `audio.play()` を呼ぶ直前に1件作ります。直前の録音の `recordingNo`（`afterRecordingNo`。録音がまだないときは `null`）、`play()` を呼ぶ直前の track の状態（`trackStatesBeforePlay`。持っていないときは空）、`play()` を呼んだ時刻（`playCalledAt`。`performance.now()`）、`play()` の結果（`playResult`。解決したら `'resolved'`、例外なら例外の `name`。結果が出るまでは `null`）、`onended` が来たか（`ended`）、`onerror` が来たか（`error`）。`fetch` の失敗などで `play()` を呼ばなかったときは記録しません
  - 開始の途中で失敗したとき（`MediaRecorder.start()` の後の、音声認識の constructor の例外など）：`legacymute` では、その開始で始めた `MediaRecorder` を止め（翻訳には送らない）、波紋とその開始で作った `AudioContext` を片付け（`AudioContext` は、`audioContextRef` に入れる前の例外（`createMediaStreamSource`、analyser、つなぎ。内側の `catch` で受けて `audioContextError` に残したもの）の後でも閉じます）、track を無効にしてから `idle` に戻ります（`microphone_denied` が出ます）。止めた録音の記録は、その `onstop` が次の録音の開始より前に来たときは、`onstop` で無効にしたので、`trackStatesAfterDisable` が `live/disabled/...` で残ります。次の録音の開始の後に来たとき（または来なかったとき）は、空のまま残ります。止めた `MediaRecorder` のデータと `onstop` が、次の録音を始めた後に遅れて来たときは、何もしません（次の録音のデータに混ぜず、track も無効にしません）。`legacy` と `legacykeep` では、今までどおり `MediaRecorder` が録音中のまま残ります
  - 表示：見出しは `（legacymute）` です。録音ごとの行に、録音の番号、有効に戻した後の track、無効にした後の track を足し、読み上げの記録を別の欄（「読み上げ」。直近の5件）に出します。「コピー」の JSON には、読み上げの記録をすべて（10 件まで）入れます
- `recogonly` のとき：発話ごとの記録（`recordings`。画面ごとに直近の 20 件）、読み上げの記録（`ttsPlays`。直近の 10 件）、画面を開いてから `start()` を呼んだ回数の合計（`recognitionStarts`。操作の中の `gesture` と、自動の始め直しの `restart`）を記録します。認識した本文は記録しません（文字数の `finalTextLength` だけ。Unicode のコードポイントの数で、Backend の `logRunes` と同じ数え方）
  - 発話ごとの記録：画面を開いてから何回目か（`recordingNo`）、言語（`lang`）、部品がなかったか（`recognitionCtorMissing`）、記録を作った時刻（`utteranceStartedAt`。出来事の時刻の基準）、最初の `start()`、`stop()`、終了の時刻（`startCalledAt`、`stopCalledAt`、`finishedAt`）、`start()`、`stop()`、部品の constructor の例外を `recogErrorName()` で文字列にした値（`startError`、`stopError`、`constructorError`。`Error` か `DOMException` なら `name`、そうでなければ `typeof`）、出来事（`events`。最大 300 件で、超えた数は `eventsDropped`）、自動の始め直しの `start()` を呼んだ回数（`autoRestarts`。例外でも数える）とその例外を `recogErrorName()` で文字列にした値（`restartErrors`）、上限に達したか（`restartLimitReached`）、自動の `onend` ごとの、その認識の最後の `result` からの時間（`silenceBeforeAutoEndMs`。その認識で `result` がなければ `null`）、`stop()` から `onend` までの時間（`stopToEndMs`。来なければ `null`）、時間切れが起きたか（`endTimeoutFired`）、終了の理由（`finishReason`。`user-stop`、`end-timeout`、`restart-limit`、`restart-start-error`、`not-allowed`、`service-not-allowed`、`unmount`、`ctor-missing`、`ctor-error`、`start-error`）、送った（送ろうとした）文字の文字数（`finalTextLength`。`discard` のときは `null`）、`result` があった認識の数（`segments`）、`/api/interpret` に `transcript` を付けて送ったか（`transcriptSent`）、翻訳の結果（`interpretResult`。`ok`、`empty`、`language_mismatch`、Backend のエラーのコード、`status_<status>`、`frontend_timeout`、`exception_<name>`、`skipped_busy`）
  - 出来事の種類：`start`（`start()` を呼んだ。`by` が `gesture` か `restart`）、`audiostart`、`soundstart`、`speechstart`、`speechend`、`soundend`、`audioend`、`result`（時刻だけ）、`error`（`event.error`）、`end`（そのときの `phase`。`listening` は自動の終わり、`stopping` は利用者の終了の後、`finished` は終了の後に来たもの）、`stop`（利用者の終了で `stop()` を呼んだ）、`abort`（`abort()` を呼んだ）。時刻（`at`）は、発話の記録を作ったときからのミリ秒（整数）です。前の発話の部品の出来事は、その発話の記録に残します
  - 読み上げの記録：直前の発話の番号（`afterRecordingNo`）、`play()` を呼んだ時刻（`playCalledAt`）、`play()` の結果（`playResult`）、`onended`（`ended`）、`onerror`（`error`）
  - 表示：見出しは `（recogonly）` です。直近の5発話を1行ずつ（番号、言語、終了の理由、自動の始め直しの回数、`stop→end`、時間切れ、文字数、`transcriptSent`、翻訳の結果、エラーの一覧。エラーの一覧には `start:`、`stop:`、`constructor:`、`restart:` を付けた例外も出す）、`start()` の回数、直近の5件の読み上げを出します。「コピー」の JSON には、すべての項目（20 件の発話と、各発話の出来事の全件）が入ります
- 表示：`exp` があるときだけ、通訳の画面の下に、診断の表示と「更新」「コピー」のボタンを出します。表示は「更新」を押したときだけ変わります（直近の5回分）。「コピー」は、押したときに最新の診断の情報を JSON でクリップボードに写します（写せないときは、選んで写せる欄に出します）。録音中（今の通訳の画面は `starting`、`recording`、`stopping`。`legacy` は `recording` と、録音の確定（`onstop` と翻訳の結果）を待つ `processing`）は押せません。`legacy` は `getUserMedia` を待つ間も `idle` のままなので、その間は押せてしまいます（新しい state を足さないため）。定期的な読み取り、新しい timer、出来事ごとの再描画はしません

#### 実機で試す手順

（1回目の実験の手順は PR #28 を見てください。ここには2回目の実験の手順と、その後に3回目、4回目、5回目の実験の手順を書きます）

1. 端末は iPhone の Safari です。スイッチを変えるたびに、Safari のアプリを終了して（アプリの切り替え画面で上にスワイプして）開き直します。タブを閉じるだけでは足りないものとします
2. 1つのスイッチで3回、毎回同じ文（「わたしのなまえはありたしんです」）を話します。毎回、次を書き留めます
   - 録音できたか（翻訳の結果が出たか）
   - 話した内容が、翻訳の結果より前に画面に出たか
   - 画面に最後に出た原文そのもの（途中で切れていないか）
   - 翻訳の結果（「Shin」が別の名前になっていないか）
3. 汚れの確かめの対照は `norecog` です。失敗したスイッチの後には `norecog` を試し、`norecog` まで失敗し始めたら、Safari のプロセスが汚れたと見て、その後の結果は捨てます
4. 順番
   1. `?exp=`（基準）
   2. `?exp=norecog`（対照）
   3. `?exp=recogfirst`
   4. `?exp=recogabort`
   5. `?exp=recogfirst,recogabort`
   6. 全部失敗したとき：`?exp=recogfirst,recogdelay`、`?exp=recogearly`、`?exp=recogonce`
   7. 成功したスイッチ：5回から10回に増やし、`trace` を足して `audioend` の時刻を見ます（`trace` を足しても成功が変わらないことも確かめます）
5. 成功の条件は次の3つで、すべてを実際に確かめて初めて成功とします
   1. 2回目からも録音できる：`ondataavailable` が通常の大きさ（数万バイト）、音量の RMS が動く（`firstNonZeroAt` が null でない）、Backend で翻訳の結果が出る
   2. 話した内容が、翻訳の結果より前に画面に出て、最後まで取れている（Backend のログの `interpret: …` の行が `hasTranscript=true`、Frontend の診断（「コピー」の JSON）の `sessions[].recognition.chars` が 0 より大きい）
   3. 固有名詞を別の名前に変えない（「Shin」が「Makoto」などにならない）
   - 判定に使わない録音
     - `recogearly`：`recognition.events` の最後の `end` が `recorder.startCalledAt` より前で、その後に `start_call` がない録音は、判定に使いません（録音の成立の前に音声認識が終わり、その録音は音声認識なしになっているため）
     - `recogonce`：前の実行の `end` が届いていなかったので音声認識を始めなかった録音（表示の「前の実行の end を待たずに飛ばした録音」、診断の `recognitionOnce.skippedPendingEnd` に番号がある録音）は、`recogonce` の判定に使いません（音声認識なしの録音で、`norecog` に近い状態のため）。飛ばした録音が続くこと（前の実行の `end` が来ないこと）は、それ自体を結果として書き留めます
6. 「更新」と「コピー」は、録音していないとき（翻訳の結果が出た後）に押します。試した後に「コピー」を押し、JSON を Claude.ai に渡します。Backend のログ（`size=`）もあわせて見ます

3回目の実験（`legacykeep`）の手順：

1. 端末は iPhone の Safari です。スイッチを変えるたびに、Safari のアプリを終了して開き直します
2. 順番
   1. `?exp=legacy`（今も2回目から失敗することの確かめ。3回）
   2. `?exp=legacykeep`（**10回**続けて話す）。10 回の間は Safari から離れません（ほかのアプリやタブに切り替えません）。`legacykeep` は、画面が隠れても、画面が外れるまでマイクを持ち続けます（ページの出来事の扱いは `legacy` と同じで、見直しは成功の後に行います）
3. 毎回「わたしのなまえはありたしんです」と話し、読み上げは押しません（マイクを開いたままの読み上げの音量や出力先は、成功の後に別に確かめる）。毎回、次を書き留めます
   - 録音できたか（翻訳の結果が出たか）
   - 話した内容が、翻訳の結果より前に画面に出たか
   - 画面に最後に出た原文そのもの（途中で切れていないか）
   - 翻訳の結果（「Shin」が別の名前になっていないか）
   - **マイクの使用のお知らせが出たか**（2回目から出ないか）
   - オレンジ色の表示が出たままか（参考）
4. 成功の条件（すべてを確かめて初めて成功とします）
   1. 全部の録音が通常の大きさ（数万バイト）で、RMS が動く（`keepStream.rmsMax` が 0 より大きく、`rmsNonZeroSamples` が 0 でない）。`blobSize` が通常の大きさで RMS が 0 のときは、`AudioContext` の状態（`audioContextState` や `audioContextFirstTickState` が `suspended` か、`audioContextError` に例外があるか）を確かめてから判断します。`audioContextError` があるときは、`audioContextState` が `null` なら作成の例外、値があれば作成の後（`createMediaStreamSource`、analyser、つなぎ）の例外として読みます。`audioContextError` が続くときは、最初の録音の例外を見て判断します（作成の後の例外では、その録音の `AudioContext` が閉じられずに残り、後の録音の例外の内容が変わることがあるため）
   2. 全部の回で、話した内容が翻訳より前に出て、最後まで取れている（Backend のログの `hasTranscript=true`。診断の `keepStream.transcriptSent` が `true`）
   3. 「Shin」が別の名前にならない
   4. 2回目から、マイクの使用のお知らせが出ない（あわせて、2回目からの `keepStream.streamReused` が `true` で、`getUserMediaCalls` が 1 のままであることを確かめます）
5. 試した後、録音していないときに「コピー」を押し、JSON を Claude.ai に渡します。`legacykeep` の記録は直近の 20 件まで残るので、10 回分はすべて JSON に入ります（`legacy` は直近の 10 件）。Backend のログもあわせて見ます

4回目の実験（`legacymute`）の手順（iPhone の Safari）：

1. Safari を終了し、`https://gotalk.chiemaru.com/?exp=legacymute` を開く
2. 10 回話す。毎回「わたしのなまえはありたしんです」。毎回、録音を止めた後にオレンジ色が消えるかを見る
3. 3回目と7回目の後に、読み上げを押す。音が出るか、どこから出るか（スピーカーか受話口か）を聞き、最後まで鳴り終わるのを待ってから次の録音をする
   - しばらく（30 秒ほど）待っても読み上げのボタンが戻らず、国旗を押せないときは、そのことを書き留め、画面を離れる前に「更新」と「コピー」で記録を取ります（`ttsPlays` の `playResult`、`ended`、`error` を見ます）。この場合、成功の条件6は失敗、条件7は判断できないとします
4. 10 回の間は Safari から離れない
5. 診断の「コピー」の JSON を取る

成功の条件（すべて）：

1. 10 回とも、録音が通常の大きさで、RMS が動く
2. 10 回とも `transcriptSent=true` で、話した内容が翻訳より前に最後まで出て、「Shin」が別の名前にならない
3. `getUserMediaCalls` が最後まで 1 で、2回目からマイクの使用のお知らせが出ない
4. 同じ track が無効と有効の間を行き来している
   - 1回目から10回目のすべてで、止めた後の `trackStatesAfterDisable` が `live/disabled/...`
   - 2回目から10回目では、開始のときの `trackStates` が `live/disabled/...`、`streamReused=true` で、有効に戻した後の `trackStatesAfterEnable` が `live/enabled/...`
   - 1回目の `trackStatesAfterEnable`（新しく取った track）も `live/enabled/...`
   - 同じ track であることは、2回目からの `streamReused=true` と、`getUserMediaCalls` が 1 のままであることで確かめます
5. すべての録音で、止めた後にオレンジ色が消える
6. 3回目と7回目の後の読み上げでは、再生の前の track が `live/disabled/...` で、スピーカーから通常の音量で最後まで鳴る。記録では `play()` が解決し、`onended` が来て、`onerror` が来ない
7. 読み上げの直後の4回目と8回目も、通常の大きさ、RMS が 0 でない、`transcriptSent=true` で成功する

条件6と7での読み上げと次の録音の対応は、`ttsPlays` の `afterRecordingNo` と、その次の `recordingNo` の録音で見ます。`MediaRecorder` を作れた後に開始の途中で失敗した録音（`MediaRecorder.start()` の例外、音声認識の constructor の例外）も番号を使うので、利用者の数える回数とずれることがあります（`getUserMedia` の失敗と `MediaRecorder` の作成の失敗では番号を使いません）

判断の仕方：

- 1から4と7が成功：マイクの扱いとして使える。5か6が失敗した場合は、オレンジ色や読み上げの扱いを Shin が決める（6が失敗なら `AudioContext` での再生を考える）
- 4が失敗：1から3が成功していても、`legacymute` 方式が成功したとは言わない
- 1から3か7が失敗：この手は使えない

5回目の実験（`recogonly`）の手順（iPhone の Safari と Chrome。それぞれで行う）：

1. ブラウザを終了してから、`https://gotalk.chiemaru.com/?exp=recogonly` を開く
2. 10 回話す（毎回「わたしのなまえはありたしんです」）。5回目と6回目は、「わたしのなまえは」の後に 5 秒ほど黙ってから「ありたしんです」と続け、自動の終わりと始め直しを起こす
3. 3回目と7回目の後に読み上げを押し、鳴り終わってから次を話す
4. 毎回、目で見て書き留める：許可のダイアログが出たか、お知らせが出たか（タップの直後と、5回目と6回目の黙った後）、話している間にオレンジ色が点いたか、止めた後に消えたか
5. 10 回の後、ページを読み込み直してもう1回話し、ダイアログやお知らせが出たかを書き留める
6. 最後に診断の「コピー」の JSON を取る

成功の条件：

1. 許可のダイアログとお知らせが、合わせて最初の1回だけ（タップでの開始、自動の始め直し、読み上げの後のいずれでも、2回目から出ない）
2. 10 回とも、話した文字が最後まで取れて `transcriptSent = true`、`interpretResult = 'ok'`、`finishReason = 'user-stop'`、原文が翻訳より前に出て、翻訳と逆翻訳が出る。「しん」が別の名前にならない。5回目と6回目で「わたしのなまえは」が消えない
3. 話している間はオレンジ色が点き、止めた後に消える
4. 3回目と7回目の後の読み上げが最後まで鳴り（`play()` が解決、`onended` あり、`onerror` なし）、直後の4回目と8回目も成功する
5. `not-allowed`、`service-not-allowed`、`audio-capture`、`network` が出ない。`restartLimitReached` と `endTimeoutFired` が出ない（この方式はブラウザの音声認識のサービスに頼るので、`network` が出たときも、翻訳が成功したかにかかわらず原因を調べる）

判断の仕方：

- 1、2、4 が成功：この方式を本番の候補にする
- 3 が失敗：扱いを Shin が決める
- 5 が失敗：原因を調べる
- 1 が失敗：この方式は使えない（マイクを開いたまま使い回し、読み上げを `AudioContext` で鳴らす方式に戻る）
- 手順5（読み込み直しの後）の結果は、条件には入れず、判断の材料にする

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
