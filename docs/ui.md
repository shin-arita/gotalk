# UI

## 1. 利用者向けの文言の言語

画面で利用者に表示する案内、警告、エラーなどの文言は、原則として、今選ばれている2つの言語で表示します。

表示の順は言語を選んだ順とし、2つの文言の間には空行を入れます。

対応する文言がない言語は、英語で表示します。

HTTP の status、内部のエラーコード、OpenAI などの内部の情報は、利用者向けの文言として直接表示しません（必要な情報はログに残します）。

利用者向けの文言は、共通の関数を通して表示します。新しい文言を加えるときは、7言語（`ja`、`en`、`zh-CN`、`zh-TW`、`ko`、`th`、`vi`）の文言を用意します。

この決まりの対象は、画面に表示する文言です。画面に見えない `aria-label` と、`<html lang="ja">` は対象に入っていません（[5. 決まりの対象に入っていないもの](#5-決まりの対象に入っていないもの)）。

## 2. 共通の関数

共通の関数は `frontend/src/messages.ts` の `getLocalizedMessage(messageKey, language1, language2)` です。文言の辞書（`MESSAGES`）と、文言のキーの型（`MessageKey`）も同じファイルにあります。

- `messageKey` の文言を、`language1` と `language2`（言語の `id`）の順に取り、空行（`\n\n`）をはさんで連結します
- 辞書にその言語の文言がない場合は、英語の文言を使います
- 選んだ言語が1つだけの場合は、その言語の文言だけを返します。1つもない場合は、英語の文言を返します

通訳画面（`frontend/src/pages/InterpreterPage.tsx`）では、`showMessage(messageKey)` が、選んだ2つの言語（`selectedLanguages` の順）で `getLocalizedMessage` を呼び、エラーの表示の位置（`role="alert"`）に表示します。

API のエラーは、日本語の文字列ではなく `ApiError`（`frontend/src/api.ts`）の `messageKey` で扱い、表示の直前に文言にします。デバッグのため、`console.warn` にエンドポイント、status、エラーの種類（Backend の `code`、`frontend_timeout`、`TypeError` などのエラーの名前）を残します。発話の内容、翻訳の結果、音声のデータ、`e.message`、Backend の `error` の文字列はログにも残しません。

ログのエラーの種類（`reason`）に入れる応答の `code` は、Backend のログ（`backend/logsafe.go`）と同じく、`^[a-z0-9_]{1,64}$` に一致する場合だけそのまま残し、一致しない場合（大文字、空白、日本語を含む、65 文字以上、空文字など）は `invalid` にします。Backend 以外（nginx の設定の誤りや別の proxy）が JSON の `code` を返した場合に、その文字列がそのままログに出ないようにするためです。表示の判定（`messageKeyForCode` の許可リスト）は、絞る前の `code` で行います。

## 3. 文言のキーと出る場面

| キー | 文言（日本語） | 出る場面 |
| --- | --- | --- |
| `input_too_large` | 入力が長すぎます。短くしてもう一度お試しください | Backend の `input_too_large`（`/api/interpret` の 400、`/api/translate` の 400 と 413）。`/api/interpret` の 413 と `/api/tts` の場合を除く |
| `service_unavailable` | 現在サービスを利用できません | Backend の `service_unavailable`（503） |
| `upstream_busy` | 混み合っています。しばらくしてからお試しください | Backend の `upstream_busy`（503） |
| `timeout` | 処理に時間がかかっています。もう一度お試しください | Backend の `timeout`（504） |
| `tts_too_long` | この翻訳は長いため、読み上げできません（500文字まで） | 読み上げる翻訳が 500 文字を超える場合（Frontend の確認）と、`/api/tts` の `input_too_large`。500 は `TTS_MAX_CHARS` から作ります |
| `recording_too_long` | 録音が長すぎます。短く区切って話してください。 | `/api/interpret` の 413（本文の形式によらない）と、送る前の録音のサイズの確認で上限を超えた場合 |
| `microphone_denied` | マイクへのアクセスが許可されていません | `getUserMedia` が失敗した場合（エラーの `name` によらない。`NotAllowedError`、`SecurityError`、`NotFoundError`、`NotReadableError` など） |
| `recording_start_failed` | うまく録音を始められませんでした。もう一度お願いします | 録音の成立の**前**の失敗：`getUserMedia` の成功の後、録音の成立までに失敗した場合（audio track がない、track が `live` でない、`MediaRecorder` の作成や `start()` の例外）。録音の成立の後の失敗には使いません |
| `recording_failed` | うまく録音できませんでした。もう一度お願いします | 録音の成立の**後**の失敗：録音の途中の `MediaRecorder` の `onerror`、利用者の停止で `MediaRecorder` の `stop()` が例外を出した場合、`onstop` が見張りの時間（`RECORDER_STOP_TIMEOUT_MS`、今は 10 秒）以内に届かなかった場合、利用者の停止の前に `MediaRecorder` が自分で止まった場合（マイクの track が終わったときなど）。音声認識の文字がなく、録音のデータが 1024 バイト未満で、録音の長さが 1 秒未満の場合（押してすぐ止めた）。どの場合も録音は Backend に送りません（[speech-flow.md](speech-flow.md) の「10. エラー処理」） |
| `microphone_no_audio` | マイクの音を受け取れませんでした。ブラウザを一度終了してから、開き直してください | 音声認識の文字がなく、録音のデータが 1024 バイト（`MIN_INTERPRET_AUDIO_BYTES`）未満で、録音の長さが 1 秒以上の場合（マイクの音が来ていない）。録音は Backend に送りません。1 秒未満のとき（押してすぐ止めた）は `recording_failed` を出します（[speech-flow.md](speech-flow.md) の「8.1 マイクの音が来ないときの検出」） |
| `generic_error` | エラーが発生しました。もう一度お試しください。 | 対応する文言がない status や `code`（502 `upstream_error` など）、ネットワークのエラー（`fetch` の reject）、応答が JSON として読めない場合など |
| `language_unclear` | 言語不明、もう一度お話ください | `/api/interpret` と `/api/translate`（再翻訳）の 422 `language_mismatch` |
| `request_timeout` | うまく翻訳できませんでした。もう一度お願いします。 | Frontend の `fetch` の timeout（`AbortController` の abort。`/api/interpret` は 65 秒、再翻訳の `/api/translate` は 30 秒）。Backend の 504（`timeout`）とは別の文言です |

7言語の文言は `frontend/src/messages.ts` の `MESSAGES` を参照してください。

読み上げ（`/api/tts`）のエラーは、`tts_too_long`、`service_unavailable`、`upstream_busy`、`timeout` の場合だけ表示します。表示する文言がないエラー（502、ネットワークのエラー、timeout など）では何も表示せず、ログにだけ残します。録音中のリアルタイム翻訳の失敗も表示しません。

## 4. まだ共通の関数に寄せていない文言

次の既存の案内の文言は、`frontend/src/pages/InterpreterPage.tsx` の中に言語ごとの辞書を持ち、それぞれの書き方で表示しています。今後、順次、共通の関数に寄せます。

- 「ただいま翻訳中です」（`TRANSLATING_MESSAGES`）、「しばらくお待ちください」（`PLEASE_WAIT_MESSAGES`）：処理中の表示。話した人の言語、相手の言語の順に、改行1つで並べます
- 「国旗をタップして話してください」（`FLAG_TAP_MESSAGES`）：それぞれの国旗の上と下に、その国旗の言語で表示します
- 録音中の画面の案内の文言「話し終わったら画面をタップしてください」（`RECORDING_GUIDE_MESSAGES`）：押した国旗の言語の1言語だけで表示します（[録音中の画面](#6-録音中の画面)）
- 逆翻訳の見出し（`BACK_TRANSLATION_LABELS`）：選んだ2つの言語を ` / ` で並べます

## 5. 決まりの対象に入っていないもの

画面に見えない `aria-label` と、`frontend/index.html` の `<html lang="ja">` は、今は日本語だけで（録音中の画面の `aria-label` を除きます。録音中の画面と下のボタンの `aria-label` は、押した国旗の言語です。[録音中の画面](#6-録音中の画面)）、[1. 利用者向けの文言の言語](#1-利用者向けの文言の言語) の決まりの対象に入っていません。4. の文言（画面に表示する文言で、今後共通の関数に寄せるもの）とは別の扱いです。

スクリーンリーダーの利用者への対応として、これらを2つの言語にするか、どの言語にするか（2つの言語を続けて読み上げるとどう聞こえるか、など）を、今後別に検討します。

| 箇所 | 今の値 | 対象の要素 |
| --- | --- | --- |
| `frontend/src/pages/LanguageSelectPage.tsx:34` | `使用する言語を2つ選択` | 言語の選択の画面の、言語のカードの一覧 |
| `frontend/src/pages/InterpreterPage.tsx:651` | `トップ画面へ戻る` | 通訳の画面の「GoTalk」の見出し（タップで戻る） |
| `frontend/src/pages/InterpreterPage.tsx:676` | `${lang.label}で話す`、`${lang.label}の録音を停止` | 国旗のボタン |
| `frontend/src/pages/InterpreterPage.tsx:981` | `原文を編集` | 原文の編集の textarea |
| `frontend/src/pages/InterpreterPage.tsx:993` | `入力`（原文が空のとき）、`編集`（原文があるとき） | 原文の入力と編集のボタン（[原文の入力と編集](#7-原文の入力と編集)） |
| `frontend/src/pages/InterpreterPage.tsx:779` | `発声する` | 読み上げのボタン |
| `frontend/index.html` | `<html lang="ja">` | ページの言語（スクリーンリーダーの読み上げの言語の判定に使われます） |

開発用の確認のページ（URL の末尾に `#tts-test` を付けたときの `frontend/src/pages/TtsTestPage.tsx` と、`#mic-test` を付けたときの `frontend/src/pages/MicTestPage.tsx`）は、開発者が実機で動作を確かめるためのもので、通常の画面からはリンクしていません。これらのページの文言は日本語だけで、[1. 利用者向けの文言の言語](#1-利用者向けの文言の言語) の決まりの対象外です。

## 6. 録音中の画面

国旗をタップしてから録音を止めるまで（状態が `starting` か `recording` で、録音中の国旗があるとき）、画面全体を録音中の画面（オーバーレイ、`recording-overlay`）で覆います。`stopping` になった時点で消えます（その後の `processing` では、今までどおり翻訳のカードに「ただいま翻訳中です」を出します）。キャンセル、中断（裏に回す、`pagehide`、戻る）、録音の失敗、マイクの音が来ないときの検出では、状態が `idle` になるので消えます。

- 画面全体を覆う要素（`position: fixed; inset: 0;`）で、背景は半透明のグレー（`rgba(40, 40, 48, 0.72)`）です。下の画面（国旗、カードなど）が透けて見えます。`z-index` は、題名、国旗、実験の表示を含む画面のすべての要素より上です
- 上から順に、次を並べます
  1. 案内の文言（`RECORDING_GUIDE_MESSAGES`）：押した国旗の言語の1言語だけを白の文字で出します（[1. 利用者向けの文言の言語](#1-利用者向けの文言の言語) の2つの言語の表示とは違います。話している本人に向けた案内のためです）。表にない言語のときは英語です

     | 言語 | 文言 |
     | --- | --- |
     | `ja` | 話し終わったら画面をタップしてください |
     | `en` | When you finish speaking, tap the screen. |
     | `zh-CN` | 说完后请点击屏幕。 |
     | `zh-TW` | 說完後請點擊螢幕。 |
     | `ko` | 말씀이 끝나면 화면을 탭해 주세요. |
     | `th` | เมื่อพูดจบแล้ว กรุณาแตะหน้าจอ |
     | `vi` | Khi nói xong, vui lòng chạm vào màn hình. |

  2. 文字の領域：話した文字（`recognizedText`）を大きめの白の文字で、その下に入力中の翻訳（`liveTranslatedText`）を小さく少し薄い色で出します（届いているときだけ）。領域の高さには上限を付け（`flex: 1`、`min-height: 0`、`overflow-y: auto`）、長くなったらこの領域だけが縦にスクロールします。新しい文字が届くたびに（話した文字、入力中の翻訳のどちらでも）、末尾（最新の行）までスクロールします。利用者が自分でスクロールして戻している場合も、新しい文字が届けば末尾に戻します（話している本人が最新の文字を見ることを優先します）。`aria-live="polite"` です
  3. 棒グラフ（[6.1](#61-棒グラフ)）
  4. 下のボタン：画面の下の中央（親指の届く位置）の、直径 72px の円です。下の余白は `calc(24px + env(safe-area-inset-bottom))` です。`recording` のときは白の四角（■、停止）、`starting` のときは白の ×（キャンセル）です。`aria-label` は、押した国旗の言語の「停止」（`STOP_BUTTON_LABELS`）か「キャンセル」（`CANCEL_BUTTON_LABELS`）です

     | 言語 | 停止 | キャンセル |
     | --- | --- | --- |
     | `ja` | 停止 | キャンセル |
     | `en` | Stop | Cancel |
     | `zh-CN` | 停止 | 取消 |
     | `zh-TW` | 停止 | 取消 |
     | `ko` | 정지 | 취소 |
     | `th` | หยุด | ยกเลิก |
     | `vi` | Dừng | Hủy |

- タップの扱い
  - `recording` のとき：録音中の画面のどこをタップしても（下のボタン、案内の文言、文字の領域、透けて見える国旗や題名の上を含む）、録音を止めます（今までの、同じ国旗の2回目のタップと同じ `stopRecording()`）。`stopRecording()` は `recording` のときだけ止めるので、2回目以降のタップは何もしません
  - `starting` のとき：録音中の画面の本体のタップは何もしません（マイクの許可のダイアログの操作の間の誤タップで、取り消さないためです）。下のボタン（×）だけが、取り消し（`abort('cancel')` で録音のセッションを片付けて `idle` に戻す。文言は出さない。[speech-flow.md](speech-flow.md) の「5. 音声入力状態」）をします
- 録音中は、録音中の画面のほかに動くものを出しません。国旗の波紋、国旗の下の横に流れる文字、入力中の翻訳のカード（`live-translation-card`）は出しません（入力中の翻訳は録音中の画面に出します）。録音中の国旗は、赤い縁取り（`lang-flags-bar__btn--recording-static`）だけで、赤い影の脈打ちはしません（`LegacyInterpreterPage` の `lang-flags-bar__btn--recording` は今までどおりです）
- 下の要素を操作できないようにする：録音中の画面と、下の click shield を出している間は、題名の `header`、国旗の帯（`lang-flags-bar`）、本文（`page-content`）、実験の表示に `inert` を付けます（キーボードやスクリーンリーダーでも操作できません）。録音中の画面は `role="dialog"`、`aria-modal="true"` で、`aria-label` は案内の文言と同じ文字です。録音中の画面が出たら、下のボタンにフォーカスを移します（`preventScroll`）

### 6.1 棒グラフ

5本の縦の棒で、高さを上下させます（棒ごとに少しずつずらします）。

- 棒グラフは、**音声認識の途中の文字が更新されている間だけ動きます**。声そのものを検知しているのではないので、話していても認識の文字が更新されなければ止まります（音声認識が遅れたとき、聞き取れなかったときなど）。声の大きさ（`onLevel`）は使いません
- 録音中（`recording`）のときだけ動きます。停止の後（`stopping`）に遅れて届いた音声認識の文字では動きません（その文字も、送信と表示には今までどおり使います）
- 音声認識の途中の文字が前と違うときだけ、動いている状態にし、800ms のタイマーを掛け直します。800ms の間に違う文字が届かなければ止めます。同じ文字がもう一度届いても延長しません（送信用の `recognizedTextRef` とは別に、棒グラフ用に最後の文字を持ちます）
- 止まっているときは、棒を低い一定の高さに戻し、色を薄くします
- 録音の開始、停止、キャンセル、中断、録音の失敗（`onStartFailed`、`onRecorderError`）、最後のデータがそろったとき（`onRecordingStopped`）、画面が外れるときに、タイマーを消して止めます
- 動きを減らす設定（`prefers-reduced-motion: reduce`）のときは、棒を動かさず、動いているときに棒の色を濃くするだけにします

### 6.2 タップの通り抜けの守り（click shield）

iPhone では、タップで要素が消えた直後に、同じ位置の下の要素に遅れて click が届くことがあります（ghost click）。録音を止めた後は、すぐに `idle` に戻る経路（マイクの音が来ないときなど）もあるので、下の国旗で次の録音が始まるおそれがあります。

そのため、録音中の画面が消えた時点から 400ms の間、透明な盾（`recording-click-shield`）を画面全体に出します。

- 理由を問わず（停止、キャンセル、中断、録音の失敗、マイクの音が来ないときの検出）、録音中の画面が消えたときに出します。録音中の画面が消える描画と盾が出る描画の間を空けないよう、変化は `useLayoutEffect` で見ます
- 盾は、録音中の画面と同じ `position: fixed; inset: 0;` で、背景は透明、`z-index` は録音中の画面と同じです。`onClick` で `preventDefault()` と `stopPropagation()` をして、何もしません（`onPointerDown` では受けません。`pointerdown` で消すと、その後の click が下に届く余地を増やすためです）
- 盾を出している間も、下の要素の `inert` を続けます。盾のタイマーは、画面が外れるときに消します

## 7. 原文の入力と編集

原文のカード（`source-card`）の右の鉛筆のボタンで、話さなくても文字を打って翻訳できます（GOTALK-6）。話した文の手直しにも使います。

- 押せるとき：状態が `idle`、`ready`、`speaking` のとき（原文が空でも押せます）。録音中、翻訳中（`starting`、`recording`、`stopping`、`processing`）と、編集の間は押せず、薄く表示します（`opacity: 0.3`）
- `aria-label`：原文が空なら「入力」、あれば「編集」です（日本語だけ。[5. 決まりの対象に入っていないもの](#5-決まりの対象に入っていないもの)）
- 押したとき：原文があればその文字を入れた状態で、空なら空の状態で、原文のカードが文字を打つ欄（`textarea`）になります。新しい文を打つときは、利用者が消して打ちます（「新しい入力」と「手直し」を分けるボタンはありません）。iPhone では、タップの処理の中で `focus()` を呼ばないとキーボードが出ないことがあるため、ボタンのタップの処理の中で、`flushSync` で `textarea` を描画してから、同じ処理の中でフォーカスを移し、カーソルを末尾に置き、高さを合わせます
- 大きさと位置：押せる範囲は 44px 角（中の鉛筆のアイコンは 24px）で、原文のカードの縦の中心に置きます（`top: 50%; transform: translateY(-50%);`、右から 8px）。原文が空のときも1行分の高さ（原文の 24px × 1.45 = 34.8px。`min-height`）を保つので、空のときと1行のときでカードの高さは変わりません。原文の右の余白（`padding-right: 56px`）は、ボタンが文字に重ならない幅です
- 確定：次のどれでも確定します。前後の空白を除いた文字が空か、前の原文と同じなら何もしません。それ以外は、`/api/translate` に選んだ2つの言語を送り、どちらの言語かを判定して訳します（今までの編集の後の再翻訳と同じ。どちらでもなければ `language_unclear`）。翻訳中の表示（「ただいま翻訳中です」）の言語の順は、最後に押した国旗から決めます（打った文の言語は応答が来るまで分からないため）。翻訳の結果は翻訳のカードに出し、履歴に足します
  - 画面のどこかをタップする：編集の間だけ、透明な覆い（`edit-confirm-shield`）を画面全体に出します（`position: fixed; inset: 0;`、`z-index: 10`。画面の普通の要素より上で、録音中の画面と click shield の `1000` より下）。原文のカードは、編集の間だけ覆いより上に出します（`source-card--editing`、`z-index: 11`）。iPhone の Safari では、押せない要素（ただの文字や余白）をタップしても `blur` が起きないことがあるためです。覆いのタップでは、`preventDefault()` と `stopPropagation()` をしてから確定します（`confirmEditFromTap()`。`textarea` にフォーカスがあれば `blur()` して `blur` の処理で確定し、フォーカスがなければ（iPhone が `focus()` を受け付けなかった、裏に回して戻った、など。フォーカスのない要素の `blur()` は `blur` の出来事を出さないため）直接確定します）。**このタップでは、確定のほかに何も起こしません**（透けて見える国旗の録音、題名の戻る、読み上げなどは起きません。もう一度タップすれば、ふつうに動きます）。覆いの `mousedown` の既定の動き（フォーカスの移動）も止めます（click の前に `blur` で覆いが消えて、click が下の要素に届かないようにするためです）
  - 原文のカードの中の、`textarea` の外（余白と、鉛筆のボタンの位置）をタップする：カードの `onClick` で、覆いのタップと同じように確定します（`confirmEditFromTap()`）。鉛筆のボタンは、編集の間は `source-card__edit--editing`（`pointer-events: none`）を付けて、タップの対象から外し、下のカードにタップを届けます（`disabled` の `<button>` の上のタップは、親へのイベントの伝わり方に頼れないためです）
  - `blur`：iPhone のキーボードの「完了」など
  - Enter（Shift なし）：ただし、日本語の入力の変換を確定する Enter（`isComposing` が真か、`keyCode` が 229）では確定しません
- 取り消し：Escape で、訳さずに元の原文に戻します
- `textarea` の中のタップでは確定しません
- 中断のとき（[speech-flow.md](speech-flow.md) の 6.6）

  | 理由 | 編集の扱い |
  | --- | --- |
  | `hidden`（裏に回す、別のアプリに切り替える） | 編集を続けます（閉じず、確定もしません）。打っている途中に、別のアプリで調べて戻ってくる使い方があるためです。戻ったら、`textarea` をタップすれば打ち続けられ、ほかの場所をタップすれば確定します（フォーカスがなくても確定します） |
  | `pagehide`（ページを離れる。bfcache を含む） | 訳さずに取り消して閉じます（ページを離れるときに問い合わせを始めないためです） |
  | `back`、`unmount` | 訳さずに取り消して閉じます |
  | `pageshow`（bfcache から戻る） | 編集の状態が残っていれば、訳さずに取り消して閉じます（`pagehide` で閉じているはずですが、残っていた場合の守りです） |

  ただし、ブラウザが裏に回すときなどに `textarea` の `blur` を出した場合は、その `blur` で確定します（`blur` の扱いは変えていません）

## 8. 関連ドキュメント

- [api.md](api.md)
- [speech-flow.md](speech-flow.md)
- [translation-flow.md](translation-flow.md)
- [testing.md](testing.md)
