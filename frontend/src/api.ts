// API の timeout（ミリ秒）。Backend の処理の deadline と nginx の proxy_read_timeout（60 秒）より長くする
// （docs/rate-limit-design.md 5.11）
export const API_TIMEOUT_MS = {
  interpret: 65_000,
  translate: 30_000,
  tts: 30_000,
} as const

// Backend のエラーの応答の code ごとの表示（docs/rate-limit-design.md 5.7）。
// 金額や OpenAI の内部のエラーコードは見せない
export const API_ERROR_MESSAGES: Record<string, string> = {
  input_too_large: '入力が長すぎます。短くしてもう一度お試しください',
  service_unavailable: '現在サービスを利用できません',
  upstream_busy: '混み合っています。しばらくしてからお試しください',
  timeout: '処理に時間がかかっています。もう一度お試しください',
}

// エラーの応答の body（{"error": "...", "code": "..."}）の code を返す。
// code がない場合や body が JSON でない場合は null
export async function apiErrorCode(res: Response): Promise<string | null> {
  try {
    const data: unknown = await res.json()
    if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string') {
      return data.code
    }
  } catch { /* JSON でない body は対象外 */ }
  return null
}

// code に対応する表示を返す。対応する表示がない場合は null
export function messageForCode(code: string | null): string | null {
  return code !== null && Object.hasOwn(API_ERROR_MESSAGES, code) ? API_ERROR_MESSAGES[code] : null
}

// エラーの応答の body の code に対応する表示を返す。
// 対応する表示がない場合や body が JSON でない場合は null
export async function apiErrorMessage(res: Response): Promise<string | null> {
  return messageForCode(await apiErrorCode(res))
}

// /api/interpret の 413（録音が大きすぎる）のときの表示。本文の形式（Backend の JSON か、nginx の HTML か）に
// かかわらず、この文言にする
export const INTERPRET_TOO_LONG_MESSAGE = '録音が長すぎます。短く区切って話してください。'

// /api/interpret に送る録音の Blob の最大のバイト数（1,032,192 バイト）。本番の nginx の client_max_body_size
// （既定の 1m = 1,048,576 バイト）から、multipart のほかのフィールドの分の余白として 16 KiB（16,384 バイト）を引いた値。
// 明らかに大きい録音の無駄な送信を避けるための、使い勝手のための事前の確認で、nginx の 413 を完全に予測するものでは
// ない（multipart の boundary や各 part の header、ほかのフィールドも body に含まれるため）。費用やセキュリティの
// 境界ではない（境界は Backend と nginx の上限）。第2段階で nginx の上限を Backend と合わせるときに見直すこと
export const MAX_INTERPRET_AUDIO_BYTES = 1_048_576 - 16_384

// /api/tts が受け付ける最大の文字数。Backend の上限（backend/limits.go の maxTextRunes）と
// 同じ値にすること。Frontend の確認は使い勝手のため、費用の防御は Backend の確認が担う
export const TTS_MAX_CHARS = 500

export const TTS_TOO_LONG_MESSAGE = `この翻訳は長いため、読み上げできません（${TTS_MAX_CHARS}文字まで）`

// 読み上げる文字列が /api/tts の上限を超えるか。Backend の ttsHandler の textTooLong と同じく、
// 前後の空白を除かずに、Unicode のコードポイント単位で数える（Go の utf8.RuneCountInString と同じ。
// サロゲートペアは 1 文字、対になっていないサロゲートも 1 文字で、Backend では U+FFFD の 1 文字になる）
export function isTooLongForTts(text: string): boolean {
  return Array.from(text).length > TTS_MAX_CHARS
}
