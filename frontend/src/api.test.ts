import { describe, it, expect } from 'vitest'
import { API_TIMEOUT_MS, TTS_MAX_CHARS, TTS_TOO_LONG_MESSAGE, apiErrorMessage, isTooLongForTts } from './api'

function res(body: unknown, json = true): Response {
  return {
    json: () => (json ? Promise.resolve(body) : Promise.reject(new SyntaxError('not json'))),
  } as unknown as Response
}

describe('API_TIMEOUT_MS', () => {
  it('is longer than the backend deadlines (55s / 25s / 25s) and nginx (60s) for interpret', () => {
    expect(API_TIMEOUT_MS.interpret).toBe(65_000)
    expect(API_TIMEOUT_MS.translate).toBe(30_000)
    expect(API_TIMEOUT_MS.tts).toBe(30_000)
  })
})

describe('apiErrorMessage', () => {
  it('returns the message for a known code', async () => {
    expect(await apiErrorMessage(res({ error: 'x', code: 'upstream_busy' }))).toBe('混み合っています。しばらくしてからお試しください')
  })

  it('returns null for unknown codes, a missing code, and non-JSON bodies', async () => {
    expect(await apiErrorMessage(res({ error: 'x', code: 'insufficient_quota' }))).toBeNull()
    expect(await apiErrorMessage(res({ error: 'x' }))).toBeNull()
    expect(await apiErrorMessage(res({ error: 'x', code: 'toString' }))).toBeNull()
    expect(await apiErrorMessage(res(null))).toBeNull()
    expect(await apiErrorMessage(res('text'))).toBeNull()
    expect(await apiErrorMessage(res(undefined, false))).toBeNull()
  })
})

describe('isTooLongForTts', () => {
  it('allows exactly TTS_MAX_CHARS characters and rejects one more', () => {
    expect(TTS_MAX_CHARS).toBe(500)
    expect(isTooLongForTts('あ'.repeat(500))).toBe(false)
    expect(isTooLongForTts('あ'.repeat(501))).toBe(true)
  })

  it('counts surrounding spaces like the backend (no trimming)', () => {
    expect(isTooLongForTts(' ' + 'a'.repeat(499))).toBe(false)
    expect(isTooLongForTts(' ' + 'a'.repeat(500))).toBe(true)
    expect(isTooLongForTts('a'.repeat(500) + '\n')).toBe(true)
  })

  it('counts code points, not UTF-16 code units', () => {
    // '😀' is one code point but two UTF-16 code units (a surrogate pair)
    expect('😀'.repeat(500).length).toBe(1000)
    expect(isTooLongForTts('😀'.repeat(500))).toBe(false)
    expect(isTooLongForTts('😀'.repeat(501))).toBe(true)
    // An unpaired surrogate is one character (the backend decodes it as one U+FFFD)
    expect(isTooLongForTts('\ud800' + 'a'.repeat(499))).toBe(false)
    expect(isTooLongForTts('\ud800' + 'a'.repeat(500))).toBe(true)
  })

  it('uses the limit in the message', () => {
    expect(TTS_TOO_LONG_MESSAGE).toBe('この翻訳は長いため、読み上げできません（500文字まで）')
  })
})
