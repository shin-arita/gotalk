import { TTS_MAX_CHARS } from './api'

// 利用者向けの文言（docs/ui.md）。画面に表示する文言は、getLocalizedMessage で選んだ2つの言語の文言にする。
// 新しい文言を加えるときは、7言語（languages.ts の LANGUAGES）の文言をそろえること
export type MessageKey =
  | 'input_too_large'
  | 'service_unavailable'
  | 'upstream_busy'
  | 'timeout'
  | 'tts_too_long'
  | 'recording_too_long'
  | 'microphone_denied'
  | 'generic_error'
  | 'language_unclear'
  | 'request_timeout'
  | 'recording_start_failed'
  | 'recording_failed'

// 文言がない言語のときに使う言語
const FALLBACK_LANGUAGE = 'en'

export const MESSAGES: Record<MessageKey, Record<string, string>> = {
  // Backend の input_too_large（/api/interpret の 413 と、/api/tts の場合を除く）
  input_too_large: {
    'ja':    '入力が長すぎます。短くしてもう一度お試しください',
    'en':    'The input is too long. Please shorten it and try again.',
    'zh-CN': '输入内容过长，请缩短后重试。',
    'zh-TW': '輸入內容過長，請縮短後再試一次。',
    'ko':    '입력이 너무 깁니다. 줄여서 다시 시도해 주세요.',
    'th':    'ข้อความยาวเกินไป กรุณาทำให้สั้นลงแล้วลองอีกครั้ง',
    'vi':    'Nội dung quá dài. Vui lòng rút ngắn và thử lại.',
  },
  // Backend の service_unavailable
  service_unavailable: {
    'ja':    '現在サービスを利用できません',
    'en':    'The service is currently unavailable.',
    'zh-CN': '服务暂时无法使用。',
    'zh-TW': '服務目前無法使用。',
    'ko':    '현재 서비스를 이용할 수 없습니다.',
    'th':    'ขณะนี้ไม่สามารถใช้บริการได้',
    'vi':    'Dịch vụ hiện không thể sử dụng.',
  },
  // Backend の upstream_busy
  upstream_busy: {
    'ja':    '混み合っています。しばらくしてからお試しください',
    'en':    'The service is busy. Please try again later.',
    'zh-CN': '当前繁忙，请稍后再试。',
    'zh-TW': '目前忙碌中，請稍後再試。',
    'ko':    '혼잡합니다. 잠시 후 다시 시도해 주세요.',
    'th':    'ขณะนี้ระบบไม่ว่าง กรุณาลองอีกครั้งภายหลัง',
    'vi':    'Hệ thống đang bận. Vui lòng thử lại sau.',
  },
  // Backend の timeout（504）
  timeout: {
    'ja':    '処理に時間がかかっています。もう一度お試しください',
    'en':    'Processing is taking too long. Please try again.',
    'zh-CN': '处理时间过长，请重试。',
    'zh-TW': '處理時間過長，請再試一次。',
    'ko':    '처리에 시간이 오래 걸리고 있습니다. 다시 시도해 주세요.',
    'th':    'การประมวลผลใช้เวลานานเกินไป กรุณาลองอีกครั้ง',
    'vi':    'Quá trình xử lý mất quá nhiều thời gian. Vui lòng thử lại.',
  },
  // 読み上げる翻訳が /api/tts の上限を超える場合（Frontend の確認と、/api/tts の input_too_large）
  tts_too_long: {
    'ja':    `この翻訳は長いため、読み上げできません（${TTS_MAX_CHARS}文字まで）`,
    'en':    `This translation is too long to be read aloud (up to ${TTS_MAX_CHARS} characters).`,
    'zh-CN': `该译文过长，无法朗读（最多${TTS_MAX_CHARS}个字符）。`,
    'zh-TW': `此譯文過長，無法朗讀（最多${TTS_MAX_CHARS}個字元）。`,
    'ko':    `번역문이 너무 길어 읽어 드릴 수 없습니다(최대 ${TTS_MAX_CHARS}자).`,
    'th':    `คำแปลนี้ยาวเกินไป ไม่สามารถอ่านออกเสียงได้ (สูงสุด ${TTS_MAX_CHARS} ตัวอักษร)`,
    'vi':    `Bản dịch này quá dài nên không thể đọc thành tiếng (tối đa ${TTS_MAX_CHARS} ký tự).`,
  },
  // /api/interpret の 413 と、送る前の録音のサイズの確認で超えた場合
  recording_too_long: {
    'ja':    '録音が長すぎます。短く区切って話してください。',
    'en':    'The recording is too long. Please speak in shorter parts.',
    'zh-CN': '录音太长，请分成较短的段落来说。',
    'zh-TW': '錄音太長，請分成較短的段落來說。',
    'ko':    '녹음이 너무 깁니다. 짧게 나누어 말씀해 주세요.',
    'th':    'การบันทึกเสียงยาวเกินไป กรุณาพูดเป็นช่วงสั้น ๆ',
    'vi':    'Bản ghi âm quá dài. Vui lòng nói ngắn gọn từng đoạn.',
  },
  // マイクを使えない場合（getUserMedia の失敗など）
  microphone_denied: {
    'ja':    'マイクへのアクセスが許可されていません',
    'en':    'Microphone access is not allowed.',
    'zh-CN': '未允许访问麦克风。',
    'zh-TW': '未允許存取麥克風。',
    'ko':    '마이크 접근이 허용되지 않았습니다.',
    'th':    'ไม่ได้รับอนุญาตให้เข้าถึงไมโครโฟน',
    'vi':    'Chưa cho phép truy cập micrô.',
  },
  // 対応する文言がない status やネットワークのエラーなど
  generic_error: {
    'ja':    'エラーが発生しました。もう一度お試しください。',
    'en':    'An error occurred. Please try again.',
    'zh-CN': '发生错误，请重试。',
    'zh-TW': '發生錯誤，請再試一次。',
    'ko':    '오류가 발생했습니다. 다시 시도해 주세요.',
    'th':    'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง',
    'vi':    'Đã xảy ra lỗi. Vui lòng thử lại.',
  },
  // Backend の language_mismatch（422）
  language_unclear: {
    'ja':    '言語不明、もう一度お話ください',
    'en':    'Language unclear. Please speak again.',
    'zh-CN': '语言不明，请再说一次',
    'zh-TW': '語言不明，請再說一次',
    'ko':    '언어를 알 수 없습니다. 다시 말씀해 주세요.',
    'th':    'ไม่ทราบภาษา กรุณาพูดอีกครั้ง',
    'vi':    'Không rõ ngôn ngữ. Vui lòng nói lại.',
  },
  // Frontend の fetch の timeout（AbortController の abort）。Backend の 504（timeout）とは別の文言にする
  request_timeout: {
    'ja':    'うまく翻訳できませんでした。もう一度お願いします。',
    'en':    'The translation didn’t work. Please try again.',
    'zh-CN': '翻译没有成功，请再试一次。',
    'zh-TW': '翻譯沒有成功，請再試一次。',
    'ko':    '번역이 잘되지 않았습니다. 다시 시도해 주세요.',
    'th':    'แปลไม่สำเร็จ กรุณาลองอีกครั้ง',
    'vi':    'Bản dịch chưa thành công. Vui lòng thử lại.',
  },
  // マイクを開いた後、録音の成立までに失敗した場合（track がない、live でない、MediaRecorder の作成や start() の例外）。
  // getUserMedia の失敗は microphone_denied、録音の成立の後の失敗は recording_failed
  recording_start_failed: {
    'ja':    'うまく録音を始められませんでした。もう一度お願いします',
    'en':    'Recording could not be started. Please try again.',
    'zh-CN': '未能开始录音，请再试一次。',
    'zh-TW': '無法開始錄音，請再試一次。',
    'ko':    '녹음을 시작하지 못했습니다. 다시 시도해 주세요.',
    'th':    'ไม่สามารถเริ่มบันทึกเสียงได้ กรุณาลองอีกครั้ง',
    'vi':    'Không thể bắt đầu ghi âm. Vui lòng thử lại.',
  },
  // 録音の成立の後に、録音が失敗した場合（録音の途中の MediaRecorder の onerror など。docs/speech-flow.md の 10.）
  recording_failed: {
    'ja':    'うまく録音できませんでした。もう一度お願いします',
    'en':    'Recording failed. Please try again.',
    'zh-CN': '录音失败，请再试一次。',
    'zh-TW': '錄音失敗，請再試一次。',
    'ko':    '녹음하지 못했습니다. 다시 시도해 주세요.',
    'th':    'ไม่สามารถบันทึกเสียงได้ กรุณาลองอีกครั้ง',
    'vi':    'Không thể ghi âm. Vui lòng thử lại.',
  },
}

function messageIn(messageKey: MessageKey, language: string): string {
  const messages = MESSAGES[messageKey]
  return Object.hasOwn(messages, language) ? messages[language] : messages[FALLBACK_LANGUAGE]
}

// 利用者向けの文言を、選んだ2つの言語（言語の id）で返す。選んだ順に、空行をはさんで連結する。
// 文言がない言語は英語にする。選んだ言語が1つだけならその言語の文言だけ、1つもなければ英語の文言を返す
export function getLocalizedMessage(messageKey: MessageKey, language1?: string, language2?: string): string {
  const languages = [language1, language2].filter((l): l is string => !!l)
  if (languages.length === 0) return messageIn(messageKey, FALLBACK_LANGUAGE)
  return languages.map(l => messageIn(messageKey, l)).join('\n\n')
}
