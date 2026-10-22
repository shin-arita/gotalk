import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { LANGUAGES } from '../languages'
import type { AudioSession, AudioSessionCallbacks } from '../hooks/useAudioSession'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { AUDIO_GLOBALS, makeTtsOkResponse, saveGlobals, setupAudioContext, ttsContextOf } from '../test/audioMocks'
import type { FakeAudioContext } from '../test/audioMocks'

// handleSpeak の守り（3.11-14）。ready で録音のセッションが残ることは正常な経路では起きないため、
// 通訳の画面の録音のセッション（useInterpreterAudioSession）を差し替えて、セッションが残っている状態を作る

const fake = vi.hoisted(() => ({
  active: false,
  callbacks: null as AudioSessionCallbacks | null,
  session: null as AudioSession | null,
  abortResolved: false,
}))

vi.mock('../hooks/useKeptAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useKeptAudioSession')>()
  return {
    ...actual,
    useInterpreterAudioSession: (callbacks: AudioSessionCallbacks) => {
      fake.callbacks = callbacks
      if (!fake.session) {
        const real = actual.createKeptAudioSession(callbacks)
        fake.session = {
          ...real,
          start: vi.fn(async () => { fake.active = true; fake.callbacks?.onRecordingStarted() }),
          stop: vi.fn(() => { fake.active = false; fake.callbacks?.onRecordingStopped(new Blob(['a'.repeat(MIN_INTERPRET_AUDIO_BYTES)])) }),
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

let restoreGlobals: () => void
let audioContexts: FakeAudioContext[]

beforeEach(() => {
  fake.active = false
  fake.session = null
  fake.abortResolved = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  audioContexts = setupAudioContext().instances
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreGlobals()
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
      return makeTtsOkResponse()
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
    expect(ttsContextOf(audioContexts)!.bufferSources[0].start).toHaveBeenCalledTimes(1)
  })

  it('does not record the guard in the normal path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }),
    } as unknown as Response)
    fetchMock.mockResolvedValueOnce(makeTtsOkResponse())
    render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    expect(fake.session!.abort).not.toHaveBeenCalledWith('error')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('records and cleans up the leftover session before returning when the AudioContext cannot be created (QQ1)', async () => {
    const nodeProcess = (globalThis as unknown as { process: { on: (type: string, f: () => void) => void; off: (type: string, f: () => void) => void } }).process
    const unhandled = vi.fn()
    nodeProcess.on('unhandledRejection', unhandled)
    try {
      setupAudioContext({ throwOnCreate: true })
      const AudioCtor = vi.fn()
      Object.defineProperty(globalThis, 'Audio', { value: AudioCtor, writable: true, configurable: true })
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }),
      } as unknown as Response)
      render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
      expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()

      // ready なのに、録音のセッションが残っている（片付けの不具合）。そのうえで AudioContext も作れない
      fake.active = true
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

      expect(fake.session!.logEvent).toHaveBeenCalledWith('unexpected_active_audio_session_before_tts')
      expect(fake.session!.getDiagnostics().events.map(e => e.type)).toEqual(expect.arrayContaining([
        'tts_context_create_failed:Error', 'unexpected_active_audio_session_before_tts',
      ]))
      expect(console.warn).toHaveBeenCalledWith('[GoTalk] unexpected_active_audio_session_before_tts')
      expect(fake.session!.abort).toHaveBeenCalledWith('error')
      expect(fake.abortResolved).toBe(true)
      expect(fake.active).toBe(false)
      expect(fetchMock).not.toHaveBeenCalledWith('/api/tts', expect.anything())
      expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(AudioCtor).not.toHaveBeenCalled()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      nodeProcess.off('unhandledRejection', unhandled)
    }
  })
})
