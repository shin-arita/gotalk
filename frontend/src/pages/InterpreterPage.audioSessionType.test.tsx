import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { getUserMediaCalls, resetKeptMicForTest } from '../audio/keptMic'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import {
  AUDIO_GLOBALS, makeFakeStream, makeTtsOkResponse, removeAudioSessionType, saveGlobals, setupAudioContext, setupAudioSessionType,
  setupDeferredGetUserMedia, setupMediaRecorder, setupSpeechRecognition, ttsContextOf,
} from '../test/audioMocks'
import type { FakeAudioContext, FakeStream } from '../test/audioMocks'
import type { AudioSession } from '../hooks/useAudioSession'

// マナーモードでも読み上げが鳴るよう、読み上げのタップの処理の中で、AudioContext を作る前と resume() の前に、
// 音の扱い（navigator.audioSession.type）を play-and-record と宣言する（GOTALK-17、docs/speech-flow.md の「9. TTS」）。
// 診断の出来事と画面の状態（status:…）は、録音のセッションの診断で確かめる（InterpreterPage.ttsCache.test.tsx と同じ）
const captured = vi.hoisted(() => ({ session: null as AudioSession | null }))

vi.mock('../hooks/useKeptAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useKeptAudioSession')>()
  return {
    ...actual,
    useInterpreterAudioSession: (...args: Parameters<typeof actual.useInterpreterAudioSession>) => {
      const session = actual.useInterpreterAudioSession(...args)
      captured.session = session
      return session
    },
  }
})

const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)
const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let audioContextCtor: ReturnType<typeof setupAudioContext>['Ctor']
let audioContexts: FakeAudioContext[]
let fetchMock: ReturnType<typeof vi.spyOn>

function okJson(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  captured.session = null
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  const audioContext = setupAudioContext()
  audioContextCtor = audioContext.Ctor
  audioContexts = audioContext.instances
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === '/api/tts') return makeTtsOkResponse()
    if (String(url) === '/api/translate') {
      const { text } = JSON.parse(String((options as RequestInit).body)) as { text: string }
      return okJson({ translatedText: `訳:${text}`, ttsText: `訳:${text}`, backTranslation: `逆:${text}`, sourceLanguage: 'ja', targetLanguage: 'en' })
    }
    return okJson({ text: 'こんにちは', translatedText: 'Hello', ttsText: 'Hello', backTranslation: '(こんにちは)', sourceLanguage: 'ja', targetLanguage: 'en' })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreGlobals()
})

function renderPage(experiment?: ExperimentConfig) {
  return render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
}

const speakButton = () => screen.queryByRole('button', { name: '発声する' })
const ttsCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/tts')
const ttsContext = () => ttsContextOf(audioContexts)!
const eventTypes = () => captured.session!.getDiagnostics().events.map(e => e.type)
const audioSessionEvents = () => eventTypes().filter(t => t.startsWith('audio_session_'))
const lastStatus = () => eventTypes().filter(t => t.startsWith('status:')).at(-1)

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

// 話さずに、空の原文に文字を入力して Enter で確定し、/api/translate の翻訳を出す
async function typeAndTranslate(text: string) {
  await act(async () => { fireEvent.click(document.querySelector('.source-card__edit')!) })
  const textarea = screen.getByRole('textbox', { name: '原文を編集' })
  fireEvent.change(textarea, { target: { value: text } })
  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }) })
  await flush()
  expect(speakButton()).not.toBeDisabled()
}

// 録音して止め、/api/interpret の翻訳を出す。getUserMedia が呼ばれたら、その呼び出しを stream で終わらせる
async function recordAndTranslate(stream: FakeStream = makeFakeStream()) {
  const callsBefore = gum.calls.length
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
  if (gum.calls.length > callsBefore) await act(async () => { await gum.calls[callsBefore].resolve(stream) })
  await act(async () => { recognitions.instances.at(-1)!.onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
  await act(async () => { fireEvent.click(document.querySelector('.recording-overlay')!) })
  const recorder = recorders.instances.at(-1)!
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob([AUDIO_DATA]) })
    recorder.onstop?.()
  })
  await flush()
  expect(speakButton()).not.toBeDisabled()
}

// 読み上げのボタンを押し、鳴らすところ（AudioBufferSourceNode の start()）まで進めて、最後まで鳴らす
async function speakToEnd() {
  await act(async () => { fireEvent.click(speakButton()!) })
  await flush()
  expect(ttsContext().bufferSources.at(-1)!.start).toHaveBeenCalledTimes(1)
  act(() => { ttsContext().bufferSources.at(-1)!.onended?.() })
  expect(lastStatus()).toBe('status:ready')
}

describe('InterpreterPage audio session type: declared before the AudioContext (GOTALK-17)', () => {
  it('sets play-and-record during the tap, before new AudioContext() and resume()', async () => {
    const audioSession = setupAudioSessionType()
    renderPage()
    await typeAndTranslate('駅はどこですか')
    expect(audioSession.setType).not.toHaveBeenCalled()

    // タップの処理の中（最初の await より前）で、宣言、AudioContext の作成、resume() がすべて済んでいる
    act(() => { fireEvent.click(speakButton()!) })
    expect(audioSession.setType).toHaveBeenCalledTimes(1)
    expect(audioSession.setType).toHaveBeenCalledWith('play-and-record')
    expect(audioSession.type).toBe('play-and-record')
    const ctx = ttsContext()
    const ctxCreatedOrder = audioContextCtor.mock.invocationCallOrder[audioContexts.indexOf(ctx)]
    const setOrder = audioSession.setType.mock.invocationCallOrder[0]
    expect(setOrder).toBeLessThan(ctxCreatedOrder)
    expect(setOrder).toBeLessThan(ctx.resume.mock.invocationCallOrder[0])

    await flush()
    expect(ctx.bufferSources[0].start).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:speaking')
    // 診断の出来事は tts_tap の後、tts_started の前に残る
    const events = eventTypes()
    expect(audioSessionEvents()).toEqual(['audio_session_type:play-and-record'])
    expect(events.indexOf('tts_tap')).toBeLessThan(events.indexOf('audio_session_type:play-and-record'))
    expect(events.indexOf('audio_session_type:play-and-record')).toBeLessThan(events.indexOf('tts_started'))
  })

  it('sets play-and-record when reading a typed text without speaking first', async () => {
    const audioSession = setupAudioSessionType()
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    expect(audioSession.type).toBe('play-and-record')
    // マイクは開かない
    expect(gum.getUserMedia).not.toHaveBeenCalled()
  })

  it('sets play-and-record when reading after speaking', async () => {
    const audioSession = setupAudioSessionType()
    renderPage()
    await recordAndTranslate()
    // 録音だけでは宣言しない（録音の部品には触らない）
    expect(audioSession.setType).not.toHaveBeenCalled()
    await speakToEnd()
    expect(audioSession.setType).toHaveBeenCalledWith('play-and-record')
    expect(audioSessionEvents()).toEqual(['audio_session_type:play-and-record'])
  })

  it('is idempotent: does not set the type again on the next taps, and records the value each time', async () => {
    const audioSession = setupAudioSessionType()
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    await speakToEnd()
    await typeAndTranslate('ありがとう')
    await speakToEnd()
    expect(audioSession.setType).toHaveBeenCalledTimes(1)
    expect(audioSessionEvents()).toEqual([
      'audio_session_type:play-and-record', 'audio_session_type:play-and-record', 'audio_session_type:play-and-record',
    ])
  })

  it('does not set the type when it is already play-and-record', async () => {
    const audioSession = setupAudioSessionType({ initialType: 'play-and-record' })
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    expect(audioSession.setType).not.toHaveBeenCalled()
    expect(audioSessionEvents()).toEqual(['audio_session_type:play-and-record'])
  })

  it('does not set the type when the text is too long to read', async () => {
    const audioSession = setupAudioSessionType()
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/tts') return makeTtsOkResponse()
      const long = 'あ'.repeat(501)
      return okJson({ translatedText: long, ttsText: long, backTranslation: '', sourceLanguage: 'ja', targetLanguage: 'en' })
    })
    renderPage()
    await typeAndTranslate('長い文')
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(audioSession.setType).not.toHaveBeenCalled()
    expect(audioSessionEvents()).toEqual([])
    expect(ttsCalls()).toHaveLength(0)
  })
})

describe('InterpreterPage audio session type: browsers without it or with a failing setter (GOTALK-17)', () => {
  it('plays as before and records audio_session_unsupported when navigator.audioSession is missing', async () => {
    removeAudioSessionType()
    expect('audioSession' in navigator).toBe(false)
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    expect(ttsCalls()).toHaveLength(1)
    expect(audioSessionEvents()).toEqual(['audio_session_unsupported'])
  })

  it('plays as before and records audio_session_set_failed when the setter throws', async () => {
    const audioSession = setupAudioSessionType({ throwOnSet: true })
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    expect(audioSession.setType).toHaveBeenCalledTimes(1)
    expect(audioSession.type).toBe('auto')
    expect(ttsCalls()).toHaveLength(1)
    expect(audioSessionEvents()).toEqual(['audio_session_set_failed:InvalidStateError'])
    // 失敗はログにも文言にも出さない
    expect(console.warn).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('InterpreterPage audio session type: the microphone is not changed (GOTALK-17)', () => {
  it('keeps the same microphone across reading and recording: one getUserMedia, no track stop(), enabled unchanged', async () => {
    setupAudioSessionType()
    const stream = makeFakeStream()
    renderPage()
    // 話さずに入力して読み上げ、その後に初めて話す（GOTALK-17 の順番）
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    await recordAndTranslate(stream)
    await speakToEnd()
    await recordAndTranslate(stream)
    await speakToEnd()

    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMediaCalls()).toBe(1)
    expect(recorders.instances).toHaveLength(2)
    stream.tracks.forEach(track => {
      expect(track.stop).not.toHaveBeenCalled()
      expect(track.enabled).toBe(true)
    })
    expect(eventTypes().filter(t => t === 'microphone_reused')).toHaveLength(1)
  })
})

describe('InterpreterPage audio session type: the experiment switch path (GOTALK-17)', () => {
  it('also sets play-and-record with a useAudioSession switch (exp=norecog), because reading goes through the same handleSpeak', async () => {
    const audioSession = setupAudioSessionType()
    renderPage(readExperimentConfig('?exp=norecog'))
    await typeAndTranslate('駅はどこですか')
    await speakToEnd()
    expect(audioSession.setType).toHaveBeenCalledWith('play-and-record')
    expect(audioSessionEvents()).toEqual(['audio_session_type:play-and-record'])
  })
})
