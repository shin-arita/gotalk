import type { MessageKey } from './messages'

// API の timeout（ミリ秒）。Backend の処理の deadline と nginx の proxy_read_timeout（60 秒）より長くする
// （docs/rate-limit-design.md 5.11）
export const API_TIMEOUT_MS = {
  interpret: 65_000,
  translate: 30_000,
  tts: 30_000,
} as const

// Backend のエラーの応答の code ごとの表示の文言のキー（docs/rate-limit-design.md 5.7、docs/ui.md）。
// 金額や OpenAI の内部のエラーコードは見せない
export const API_ERROR_MESSAGE_KEYS: Record<string, MessageKey> = {
  input_too_large: 'input_too_large',
  service_unavailable: 'service_unavailable',
  upstream_busy: 'upstream_busy',
  timeout: 'timeout',
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

// code に対応する表示の文言のキーを返す。対応する表示がない場合は null
export function messageKeyForCode(code: string | null): MessageKey | null {
  return code !== null && Object.hasOwn(API_ERROR_MESSAGE_KEYS, code) ? API_ERROR_MESSAGE_KEYS[code] : null
}

// ログに残す reason の形式。Backend のログ（backend/logsafe.go の openAIErrorTokenRe）と同じく、
// これに一致しない値（Backend 以外の proxy などが返した code など）は、そのまま残さずに invalid にする
const LOG_REASON_RE = /^[a-z0-9_]{1,64}$/

function safeReason(reason: string | null): string | null {
  return reason === null || LOG_REASON_RE.test(reason) ? reason : 'invalid'
}

// API の呼び出しのエラー。利用者には messageKey の文言だけを表示し、status と reason（Backend の code、
// または Frontend で判定した理由）はログにだけ残す。messageKey が null のときは、表示する文言がない。
// reason は形式で絞る（safeReason）。表示の判定（messageKeyForCode）は、絞る前の code で行う
export class ApiError extends Error {
  readonly messageKey: MessageKey | null
  readonly endpoint: string
  readonly status: number | null
  readonly reason: string | null

  constructor(messageKey: MessageKey | null, endpoint: string, status: number | null, reason: string | null) {
    const loggedReason = safeReason(reason)
    super(`${endpoint} failed (status: ${status ?? '-'}, reason: ${loggedReason ?? '-'})`)
    this.name = 'ApiError'
    this.messageKey = messageKey
    this.endpoint = endpoint
    this.status = status
    this.reason = loggedReason
  }
}

// エラーの応答から ApiError を作る。code に対応する文言がない場合は汎用のエラーにする
export async function apiErrorFromResponse(endpoint: string, res: Response): Promise<ApiError> {
  const code = await apiErrorCode(res)
  return new ApiError(messageKeyForCode(code) ?? 'generic_error', endpoint, res.status, code)
}

// API の呼び出しのエラーを、デバッグのためにコンソールに残す。残すのはエンドポイント、status、エラーの種類だけで、
// 発話の内容、翻訳の結果、音声のデータ、e.message（応答の本文の一部を含むことがある）は残さない
export function logApiError(endpoint: string, e: unknown): void {
  if (e instanceof ApiError) {
    console.warn('[GoTalk] API error', { endpoint: e.endpoint, status: e.status, reason: e.reason })
  } else if (e instanceof DOMException && e.name === 'AbortError') {
    console.warn('[GoTalk] API error', { endpoint, status: null, reason: 'frontend_timeout' })
  } else {
    console.warn('[GoTalk] API error', { endpoint, status: null, reason: e instanceof Error ? e.name : typeof e })
  }
}

// API の呼び出しのエラーを、表示の文言のキーにする（ログも残す）。Frontend の timeout は request_timeout、
// 対応する文言がないエラー（ネットワークのエラーなど）は generic_error にする
export function messageKeyForError(endpoint: string, e: unknown): MessageKey {
  logApiError(endpoint, e)
  if (e instanceof ApiError) return e.messageKey ?? 'generic_error'
  if (e instanceof DOMException && e.name === 'AbortError') return 'request_timeout'
  return 'generic_error'
}

// /api/interpret に送る録音の Blob の最大のバイト数（1,032,192 バイト）。本番の nginx の client_max_body_size
// （既定の 1m = 1,048,576 バイト）から、multipart のほかのフィールドの分の余白として 16 KiB（16,384 バイト）を引いた値。
// 明らかに大きい録音の無駄な送信を避けるための、使い勝手のための事前の確認で、nginx の 413 を完全に予測するものでは
// ない（multipart の boundary や各 part の header、ほかのフィールドも body に含まれるため）。費用やセキュリティの
// 境界ではない（境界は Backend と nginx の上限）。第2段階で nginx の上限を Backend と合わせるときに見直すこと
export const MAX_INTERPRET_AUDIO_BYTES = 1_048_576 - 16_384

// /api/tts が受け付ける最大の文字数。Backend の上限（backend/limits.go の maxTextRunes）と
// 同じ値にすること。Frontend の確認は使い勝手のため、費用の防御は Backend の確認が担う
export const TTS_MAX_CHARS = 500

// 読み上げる文字列が /api/tts の上限を超えるか。Backend の ttsHandler の textTooLong と同じく、
// 前後の空白を除かずに、Unicode のコードポイント単位で数える（Go の utf8.RuneCountInString と同じ。
// サロゲートペアは 1 文字、対になっていないサロゲートも 1 文字で、Backend では U+FFFD の 1 文字になる）
export function isTooLongForTts(text: string): boolean {
  return Array.from(text).length > TTS_MAX_CHARS
}
