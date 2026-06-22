# GoTalk 発声品質調査

## 背景

翻訳画面の発声ボタンで音声は再生されるが、音質が悪く不自然。

将来的に OpenAI TTS 化を検討しているが、まず現状実装を調査したい。

今回は調査のみ。
実装変更は禁止。

## 調査項目

1. 発声ボタンの実装箇所
2. 発声処理の呼び出し元
3. speechSynthesis 利用有無
4. SpeechSynthesisUtterance 利用有無
5. voice 選択方法
6. lang 設定方法
7. 発声対象テキスト
8. エラーハンドリング有無
9. iPhone / Android / PC で品質差が出る要因
10. OpenAI TTS 化する場合の改修対象ファイル一覧

## 調査対象

- frontend
- backend
- README
- docs

## 禁止事項

- 実装変更
- commit
- push
- PR merge

## 出力形式

# 発声処理調査結果

## 現在の発声方式

## 実装ファイル

## 処理フロー

## 品質問題の原因候補

## OpenAI TTS 化した場合の改修箇所

## 推奨方針
