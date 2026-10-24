import { describe, it, expect } from 'vitest'
import { MESSAGES, getLocalizedMessage } from './messages'
import type { MessageKey } from './messages'
import { LANGUAGES } from './languages'

describe('getLocalizedMessage', () => {
  it('joins the messages of the two languages in the selected order with a blank line', () => {
    expect(getLocalizedMessage('generic_error', 'ja', 'en')).toBe(
      'エラーが発生しました。もう一度お試しください。\n\nAn error occurred. Please try again.',
    )
    expect(getLocalizedMessage('generic_error', 'en', 'ja')).toBe(
      'An error occurred. Please try again.\n\nエラーが発生しました。もう一度お試しください。',
    )
    expect(getLocalizedMessage('recording_too_long', 'th', 'vi')).toBe(
      'การบันทึกเสียงยาวเกินไป กรุณาพูดเป็นช่วงสั้น ๆ\n\nBản ghi âm quá dài. Vui lòng nói ngắn gọn từng đoạn.',
    )
  })

  it('uses English for a language without a message', () => {
    expect(getLocalizedMessage('upstream_busy', 'fr', 'ja')).toBe(
      'The service is busy. Please try again later.\n\n混み合っています。しばらくしてからお試しください',
    )
    expect(getLocalizedMessage('upstream_busy', 'ko', 'toString')).toBe(
      '혼잡합니다. 잠시 후 다시 시도해 주세요.\n\nThe service is busy. Please try again later.',
    )
  })

  it('shows only the selected language when one language is selected', () => {
    expect(getLocalizedMessage('timeout', 'ja')).toBe('処理に時間がかかっています。もう一度お試しください')
    expect(getLocalizedMessage('timeout', undefined, 'vi')).toBe('Quá trình xử lý mất quá nhiều thời gian. Vui lòng thử lại.')
  })

  it('shows English when no language is selected', () => {
    expect(getLocalizedMessage('timeout')).toBe('Processing is taking too long. Please try again.')
    expect(getLocalizedMessage('timeout', '', '')).toBe('Processing is taking too long. Please try again.')
  })

  it('builds the TTS message from TTS_MAX_CHARS', () => {
    expect(getLocalizedMessage('tts_too_long', 'ja', 'en')).toBe(
      'この翻訳は長いため、読み上げできません（500文字まで）\n\nThis translation is too long to be read aloud (up to 500 characters).',
    )
  })

  it('uses U+2019 in the English request timeout message', () => {
    expect(MESSAGES.request_timeout.en).toBe('The translation didn’t work. Please try again.')
  })

  it('has the recording start failure messages (ja without a period, the others with one)', () => {
    expect(getLocalizedMessage('recording_start_failed', 'ja', 'en')).toBe(
      'うまく録音を始められませんでした。もう一度お願いします\n\nRecording could not be started. Please try again.',
    )
    expect(MESSAGES.recording_start_failed).toEqual({
      'ja':    'うまく録音を始められませんでした。もう一度お願いします',
      'en':    'Recording could not be started. Please try again.',
      'zh-CN': '未能开始录音，请再试一次。',
      'zh-TW': '無法開始錄音，請再試一次。',
      'ko':    '녹음을 시작하지 못했습니다. 다시 시도해 주세요.',
      'th':    'ไม่สามารถเริ่มบันทึกเสียงได้ กรุณาลองอีกครั้ง',
      'vi':    'Không thể bắt đầu ghi âm. Vui lòng thử lại.',
    })
  })

  it('has the recording failure messages (ja without a period, the others with one)', () => {
    expect(getLocalizedMessage('recording_failed', 'ja', 'en')).toBe(
      'うまく録音できませんでした。もう一度お願いします\n\nRecording failed. Please try again.',
    )
    expect(MESSAGES.recording_failed).toEqual({
      'ja':    'うまく録音できませんでした。もう一度お願いします',
      'en':    'Recording failed. Please try again.',
      'zh-CN': '录音失败，请再试一次。',
      'zh-TW': '錄音失敗，請再試一次。',
      'ko':    '녹음하지 못했습니다. 다시 시도해 주세요.',
      'th':    'ไม่สามารถบันทึกเสียงได้ กรุณาลองอีกครั้ง',
      'vi':    'Không thể ghi âm. Vui lòng thử lại.',
    })
  })

  it('has the microphone no audio messages (ja without a period, the others with one)', () => {
    expect(getLocalizedMessage('microphone_no_audio', 'ja', 'en')).toBe(
      'マイクの音を受け取れませんでした。ブラウザを一度終了してから、開き直してください\n\nThe microphone audio could not be received. Please close the browser completely and open it again.',
    )
    expect(MESSAGES.microphone_no_audio).toEqual({
      'ja':    'マイクの音を受け取れませんでした。ブラウザを一度終了してから、開き直してください',
      'en':    'The microphone audio could not be received. Please close the browser completely and open it again.',
      'zh-CN': '未能接收到麦克风的声音。请完全关闭浏览器后重新打开。',
      'zh-TW': '無法接收麥克風的聲音。請完全關閉瀏覽器後重新開啟。',
      'ko':    '마이크 소리를 받지 못했습니다. 브라우저를 완전히 종료한 후 다시 열어 주세요.',
      'th':    'ไม่ได้รับเสียงจากไมโครโฟน กรุณาปิดเบราว์เซอร์ให้สนิทแล้วเปิดใหม่อีกครั้ง',
      'vi':    'Không nhận được âm thanh từ micrô. Vui lòng đóng hẳn trình duyệt rồi mở lại.',
    })
  })

  it('keeps the existing language unclear messages', () => {
    expect(getLocalizedMessage('language_unclear', 'ja', 'en')).toBe(
      '言語不明、もう一度お話ください\n\nLanguage unclear. Please speak again.',
    )
  })

  it('has the photo translation messages (ja without a period, the others with one, th without one)', () => {
    expect(MESSAGES.no_text_found).toEqual({
      'ja':    '写真から文字を読み取れませんでした',
      'en':    'No text could be read from the photo.',
      'zh-CN': '无法从照片中读取文字。',
      'zh-TW': '無法從照片中讀取文字。',
      'ko':    '사진에서 글자를 읽을 수 없었습니다.',
      'th':    'ไม่สามารถอ่านข้อความจากรูปภาพได้',
      'vi':    'Không thể đọc chữ từ ảnh.',
    })
    expect(MESSAGES.photo_too_much_text).toEqual({
      'ja':    '写真の文字が多すぎます、訳したいところを撮り直してください',
      'en':    'The photo has too much text. Please retake just the part you want translated.',
      'zh-CN': '照片中的文字太多。请只拍摄需要翻译的部分。',
      'zh-TW': '照片中的文字太多。請只拍攝需要翻譯的部分。',
      'ko':    '사진에 글자가 너무 많습니다. 번역할 부분만 다시 찍어 주세요.',
      'th':    'รูปภาพมีข้อความมากเกินไป กรุณาถ่ายใหม่เฉพาะส่วนที่ต้องการแปล',
      'vi':    'Ảnh có quá nhiều chữ. Vui lòng chụp lại phần bạn muốn dịch.',
    })
    expect(MESSAGES.photo_load_failed).toEqual({
      'ja':    '写真を開けませんでした、別の写真でお試しください',
      'en':    'The photo could not be opened. Please try another photo.',
      'zh-CN': '无法打开照片，请换一张照片再试。',
      'zh-TW': '無法開啟照片，請換一張照片再試一次。',
      'ko':    '사진을 열 수 없습니다. 다른 사진으로 다시 시도해 주세요.',
      'th':    'ไม่สามารถเปิดรูปภาพได้ กรุณาลองใช้รูปภาพอื่น',
      'vi':    'Không thể mở ảnh. Vui lòng thử ảnh khác.',
    })
    expect(MESSAGES.photo_too_large).toEqual({
      'ja':    '写真が大きすぎます、別の写真でお試しください',
      'en':    'The photo is too large. Please try another photo.',
      'zh-CN': '照片太大，请换一张照片再试。',
      'zh-TW': '照片太大，請換一張照片再試一次。',
      'ko':    '사진이 너무 큽니다. 다른 사진으로 다시 시도해 주세요.',
      'th':    'รูปภาพมีขนาดใหญ่เกินไป กรุณาลองใช้รูปภาพอื่น',
      'vi':    'Ảnh quá lớn. Vui lòng thử ảnh khác.',
    })
  })

  // 写真の翻訳の日本語の文言は、文末だけでなく文中にも句点（。）を使わない（PR #39 の WW1）
  it('has no Japanese period anywhere in the photo translation messages', () => {
    const keys: MessageKey[] = ['no_text_found', 'photo_too_much_text', 'photo_load_failed', 'photo_too_large']
    for (const key of keys) expect(MESSAGES[key].ja, key).not.toContain('。')
  })

  // 2つの文からなる日本語の文言は、句点の代わりに読点（、）でつなぐ（PR #39 の WW1 の続き）
  it('joins the two sentences of the Japanese photo translation messages with a reading mark', () => {
    expect(getLocalizedMessage('photo_too_much_text', 'ja')).toBe('写真の文字が多すぎます、訳したいところを撮り直してください')
    expect(getLocalizedMessage('photo_load_failed', 'ja')).toBe('写真を開けませんでした、別の写真でお試しください')
    expect(getLocalizedMessage('photo_too_large', 'ja')).toBe('写真が大きすぎます、別の写真でお試しください')
  })

  it('has messages in all 7 languages for all 17 keys', () => {
    const keys: MessageKey[] = [
      'input_too_large', 'service_unavailable', 'upstream_busy', 'timeout', 'tts_too_long',
      'recording_too_long', 'microphone_denied', 'generic_error', 'language_unclear', 'request_timeout',
      'recording_start_failed', 'recording_failed', 'microphone_no_audio',
      'no_text_found', 'photo_too_much_text', 'photo_load_failed', 'photo_too_large',
    ]
    expect(Object.keys(MESSAGES).sort()).toEqual([...keys].sort())
    const languageIds = LANGUAGES.map(l => l.id)
    expect(languageIds).toEqual(['ja', 'en', 'zh-CN', 'zh-TW', 'ko', 'th', 'vi'])
    for (const key of keys) {
      expect(Object.keys(MESSAGES[key]).sort(), key).toEqual([...languageIds].sort())
      for (const id of languageIds) expect(MESSAGES[key][id].trim(), `${key} ${id}`).not.toBe('')
    }
  })
})
