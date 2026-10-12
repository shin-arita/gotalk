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

  it('keeps the existing language unclear messages', () => {
    expect(getLocalizedMessage('language_unclear', 'ja', 'en')).toBe(
      '言語不明、もう一度お話ください\n\nLanguage unclear. Please speak again.',
    )
  })

  it('has messages in all 7 languages for all 11 keys', () => {
    const keys: MessageKey[] = [
      'input_too_large', 'service_unavailable', 'upstream_busy', 'timeout', 'tts_too_long',
      'recording_too_long', 'microphone_denied', 'generic_error', 'language_unclear', 'request_timeout',
      'recording_start_failed',
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
