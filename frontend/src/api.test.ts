import { describe, it, expect, vi, afterEach } from 'vitest'
import { API_TIMEOUT_MS, ApiError, MAX_INTERPRET_AUDIO_BYTES, TTS_MAX_CHARS, apiErrorFromResponse, isTooLongForTts, messageKeyForError } from './api'

function res(body: unknown, json = true, status = 500): Response {
  return {
    status,
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

describe('apiErrorFromResponse', () => {
  it('uses the message key for a known code and keeps the status and code for the log', async () => {
    const e = await apiErrorFromResponse('/api/translate', res({ error: 'x', code: 'upstream_busy' }, true, 503))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.messageKey).toBe('upstream_busy')
    expect(e.endpoint).toBe('/api/translate')
    expect(e.status).toBe(503)
    expect(e.reason).toBe('upstream_busy')
  })

  it('uses the generic error for unknown codes, a missing code, and non-JSON bodies', async () => {
    for (const body of [{ error: 'x', code: 'insufficient_quota' }, { error: 'x' }, { error: 'x', code: 'toString' }, null, 'text']) {
      expect((await apiErrorFromResponse('/api/interpret', res(body))).messageKey).toBe('generic_error')
    }
    expect((await apiErrorFromResponse('/api/interpret', res(undefined, false))).messageKey).toBe('generic_error')
  })
})

describe('messageKeyForError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the key of an ApiError, request_timeout for an abort, and generic_error for other errors', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(messageKeyForError('/api/interpret', new ApiError('recording_too_long', '/api/interpret', 413, null))).toBe('recording_too_long')
    expect(messageKeyForError('/api/tts', new ApiError(null, '/api/tts', 502, 'upstream_error'))).toBe('generic_error')
    expect(messageKeyForError('/api/interpret', new DOMException('Aborted', 'AbortError'))).toBe('request_timeout')
    expect(messageKeyForError('/api/interpret', new TypeError('Failed to fetch'))).toBe('generic_error')
    expect(messageKeyForError('/api/interpret', 'oops')).toBe('generic_error')
  })

  it('logs the endpoint, status, and kind of error, but not e.message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    messageKeyForError('/api/translate', new ApiError('generic_error', '/api/translate', 502, 'upstream_error'))
    messageKeyForError('/api/interpret', new DOMException('Aborted', 'AbortError'))
    messageKeyForError('/api/interpret', new SyntaxError('Unexpected token in JSON: secret translation'))
    expect(warn.mock.calls).toEqual([
      ['[GoTalk] API error', { endpoint: '/api/translate', status: 502, reason: 'upstream_error' }],
      ['[GoTalk] API error', { endpoint: '/api/interpret', status: null, reason: 'frontend_timeout' }],
      ['[GoTalk] API error', { endpoint: '/api/interpret', status: null, reason: 'SyntaxError' }],
    ])
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
})

describe('MAX_INTERPRET_AUDIO_BYTES', () => {
  it('is the nginx limit (1 MiB) minus a 16 KiB margin for the other multipart fields', () => {
    expect(MAX_INTERPRET_AUDIO_BYTES).toBe(1_032_192)
  })
})
