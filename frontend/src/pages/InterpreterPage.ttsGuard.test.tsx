import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { LANGUAGES } from '../languages'
import type { AudioSession, AudioSessionCallbacks } from '../hooks/useAudioSession'

// handleSpeak の守り（3.11-14）。ready で録音のセッションが残ることは正常な経路では起きないため、
// useAudioSession を差し替えて、セッションが残っている状態を作る

const fake = vi.hoisted(() => ({
  active: false,
  callbacks: null as AudioSessionCallbacks | null,
  session: null as AudioSession | null,
  abortResolved: false,
}))

vi.mock('../hooks/useAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAudioSession')>()
  return {
    ...actual,
    useAudioSession: (callbacks: AudioSessionCallbacks) => {
      fake.callbacks = callbacks
      if (!fake.session) {
        const real = actual.createAudioSession(callbacks)
        fake.session = {
          ...real,
          start: vi.fn(async () => { fake.active = true; fake.callbacks?.onRecordingStarted() }),
          stop: vi.fn(() => { fake.active = false; fake.callbacks?.onRecordingStopped(new Blob(['audio'])) }),
          abort: vi.fn(async () => {
            await Promise.resolve()
            fake.active = false
            fake.abortResolved = true
          }),
          hasActiveSession: () => fake.active,
          logEvent: vi.fn(real.logEvent),
        }
      }
      return fake.session
    },
  }
})

const [ja, en] = LANGUAGES

beforeEach(() => {
  fake.active = false
  fake.session = null
  fake.abortResolved = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(globalThis, 'Audio', {
    value: vi.fn(function () { return { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), onended: null, onerror: null } }),
    writable: true,
    configurable: true,
  })
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:fake')
  globalThis.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('InterpreterPage handleSpeak guard (3.11-14)', () => {
  it('records unexpected_active_audio_session_before_tts, and plays only after the cleanup finishes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }),
    } as unknown as Response)
    fetchMock.mockImplementationOnce(async () => {
      // /api/tts を呼ぶのは、片付けが終わった後
      expect(fake.abortResolved).toBe(true)
      return { ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'])) } as unknown as Response
    })
    render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()

    // ready なのに、録音のセッションが残っている（片付けの不具合）
    fake.active = true
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })

    expect(fake.session!.abort).toHaveBeenCalledWith('error')
    expect(fake.session!.logEvent).toHaveBeenCalledWith('unexpected_active_audio_session_before_tts')
    expect(fake.session!.getDiagnostics().events.map(e => e.type)).toContain('unexpected_active_audio_session_before_tts')
    expect(console.warn).toHaveBeenCalledWith('[GoTalk] unexpected_active_audio_session_before_tts')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tts', expect.anything())
    expect(globalThis.Audio).toHaveBeenCalledTimes(1)
  })

  it('does not record the guard in the normal path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }),
    } as unknown as Response)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'])) } as unknown as Response)
    render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    expect(fake.session!.abort).not.toHaveBeenCalledWith('error')
    expect(console.warn).not.toHaveBeenCalled()
  })
})
