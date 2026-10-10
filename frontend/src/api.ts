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

// エラーの応答の body（{"error": "...", "code": "..."}）の code に対応する表示を返す。
// 対応する表示がない場合や body が JSON でない場合は null
export async function apiErrorMessage(res: Response): Promise<string | null> {
  try {
    const data: unknown = await res.json()
    if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' &&
      Object.hasOwn(API_ERROR_MESSAGES, data.code)) {
      return API_ERROR_MESSAGES[data.code]
    }
  } catch { /* JSON でない body は対象外 */ }
  return null
}
