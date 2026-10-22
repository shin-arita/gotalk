import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { RECORDER_STOP_TIMEOUT_MS } from '../hooks/useAudioSession'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { peekLive, resetKeptMicForTest } from '../audio/keptMic'
import { LANGUAGES } from '../languages'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import {
  AUDIO_GLOBALS, endTrack, firePageTransition, makeFakeStream, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia,
  setupMediaRecorder, setupSpeechRecognition, setVisibility, ttsContextOf,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// 録音のライフサイクル（docs/speech-flow.md）のテスト。番号は、設計の 3.11 のテストの番号。
// 実験のスイッチがないときの、マイクを閉じないセッション（useKeptAudioSession）の期待にしている。
// マイクはページ全体で1つ持ち、録音の後も中断のときも track の stop() を呼ばない（ended のときだけ取り直す）。
// 実験のスイッチがあるとき（useAudioSession）の、録音のたびの getUserMedia と track の stop() は、
// InterpreterPage.experiments.test.tsx と useAudioSession の単体テストで確かめる

// 録音のデータ。マイクの音が来ていないかの判定（MIN_INTERPRET_AUDIO_BYTES 未満は送らない）に掛からない大きさにする
const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)

const [ja, en] = LANGUAGES
const jaEn = (key: MessageKey) => getLocalizedMessage(key, 'ja', 'en')

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>

interface FetchCall {
  url: string
  options: RequestInit
  resolve: (res: Response) => void
  reject: (e: unknown) => void
}

let fetchCalls: FetchCall[]
let fetchMock: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  resolvedGum = 0
  lastStream = undefined
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  fetchCalls = []
  // fetch は、テストが resolve や reject をするまで終わらない（abort しても終わらない。遅れて戻る結果を試すため）
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => new Promise((resolve, reject) => {
    fetchCalls.push({ url: String(url), options: options ?? {}, resolve, reject })
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreGlobals()
})

function okResponse(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

function errorResponse(status: number, body: object): Response {
  return { ok: false, status, json: () => Promise.resolve(body) } as unknown as Response
}

const audioResponse = makeTtsOkResponse

function interpretResult(translatedText = 'こんにちは') {
  return { text: 'Hello', translatedText, ttsText: translatedText, backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }
}

// 読み上げは AudioContext で鳴らす。<audio>（Audio）は呼ばれないことを確かめるために spy を置く
function setupAudio() {
  const { instances } = setupAudioContext()
  const AudioCtor = vi.fn()
  Object.defineProperty(globalThis, 'Audio', { value: AudioCtor, writable: true, configurable: true })
  const source = () => ttsContextOf(instances)?.bufferSources.at(-1)
  return { instances, AudioCtor, source }
}

function renderPage(onBack = vi.fn()) {
  return { onBack, ...render(<InterpreterPage selectedLanguages={[ja, en]} onBack={onBack} />) }
}

const jaTalk = () => screen.getByRole('button', { name: 'Japaneseで話す' })
const jaStop = () => screen.queryByRole('button', { name: 'Japaneseの録音を停止' })
const speakButton = () => screen.queryByRole('button', { name: '発声する' })
const isProcessing = () => document.querySelector('.translation-card__text--processing') !== null
const translationText = () => document.querySelector('.translation-card__text')?.textContent
const alertText = () => screen.queryByRole('alert')?.textContent

async function tapJa() {
  await act(async () => { fireEvent.click(jaTalk()) })
}

// 終わらせた getUserMedia の数と、最後に返した stream（マイクを使い回すときは、getUserMedia を呼ばずにこの stream を使う）
let resolvedGum = 0
let lastStream: FakeStream | undefined

async function resolveGum(index: number, stream?: FakeStream): Promise<FakeStream> {
  let resolved: FakeStream | undefined
  await act(async () => { resolved = await gum.calls[index].resolve(stream) })
  resolvedGum = Math.max(resolvedGum, index + 1)
  lastStream = resolved
  return resolved!
}

// 日本語の国旗をタップし、まだ終わらせていない getUserMedia があれば終わらせて recording にする。
// マイクを使い回すとき（getUserMedia を呼ばないとき）は、持っている stream を返す
async function startJaRecording(): Promise<FakeStream> {
  await tapJa()
  if (gum.calls.length > resolvedGum) return resolveGum(resolvedGum)
  return lastStream!
}

async function tapStop() {
  await act(async () => { fireEvent.click(jaStop()!) })
}

// MediaRecorder の最後のデータと onstop を起こす
async function finishRecorder(index: number, data = AUDIO_DATA) {
  await act(async () => {
    recorders.instances[index].ondataavailable?.({ data: new Blob([data]) })
    recorders.instances[index].onstop?.()
  })
}

async function resolveFetch(index: number, res: Response) {
  await act(async () => { fetchCalls[index].resolve(res) })
}

// 録音して止め、/api/interpret の結果を返して ready にする
async function reachReady(recordingIndex = 0, translatedText = 'こんにちは') {
  await startJaRecording()
  await tapStop()
  await finishRecorder(recordingIndex)
  await resolveFetch(fetchCalls.length - 1, okResponse(interpretResult(translatedText)))
}

// ready から読み上げを始め、AudioContext での再生（AudioBufferSourceNode の start()）まで進める
async function reachSpeaking() {
  const tts = setupAudio()
  await reachReady()
  await act(async () => { fireEvent.click(speakButton()!) })
  await resolveFetch(fetchCalls.length - 1, audioResponse())
  await act(async () => { await Promise.resolve() })
  expect(tts.source()?.start).toHaveBeenCalledTimes(1)
  return { ...tts, source: tts.source()! }
}

async function editAndRetranslate(text: string) {
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  const textarea = screen.getByRole('textbox', { name: '原文を編集' })
  fireEvent.change(textarea, { target: { value: text } })
  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }) })
}

describe('InterpreterPage audio lifecycle: start', () => {
  it('calls getUserMedia only once when the flag is tapped again while starting (3.11-1)', async () => {
    renderPage()
    await tapJa()
    // starting の間は、国旗を押せない
    expect(jaTalk()).toBeDisabled()
    await act(async () => { fireEvent.click(jaTalk()) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Englishで話す' })) })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    await resolveGum(0)
    expect(jaStop()).toBeInTheDocument()
    expect(recorders.Ctor).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['hidden', () => setVisibility('hidden')],
    ['pagehide', () => firePageTransition('pagehide', false)],
    ['back', () => fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' }))],
  ])('keeps the stream that getUserMedia returns after %s, does not start recording, and reuses it next time (3.11-2)', async (_, interrupt) => {
    const { onBack } = renderPage()
    await tapJa()
    await act(async () => { interrupt() })
    const stream = await resolveGum(0)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(peekLive()).toBe(stream)
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(jaStop()).not.toBeInTheDocument()
    if (onBack.mock.calls.length > 0) return
    expect(jaTalk()).not.toBeDisabled()
    // 次の録音は、getUserMedia を呼ばずに、取得した stream で始める
    await tapJa()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(jaStop()).toBeInTheDocument()
    expect(recorders.Ctor).toHaveBeenCalledWith(stream, undefined)
  })

  it('keeps the stream that getUserMedia returns after unmount, and does not start recording (3.11-2)', async () => {
    const { unmount } = renderPage()
    await tapJa()
    unmount()
    const stream = await act(async () => gum.calls[0].resolve())
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(peekLive()).toBe(stream)
    expect(recorders.Ctor).not.toHaveBeenCalled()
  })

  it('does not stop the tracks, shows the message in the two languages, and returns to idle when MediaRecorder cannot be created (3.11-3)', async () => {
    setupMediaRecorder({ throwOnCreate: true })
    renderPage()
    const stream = await startJaRecording()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(alertText()).toBe(jaEn('recording_start_failed'))
    expect(jaTalk()).not.toBeDisabled()
  })

  it('shows the recording start message when the track is not live, and acquires again on the next start', async () => {
    renderPage()
    await tapJa()
    const stream = await resolveGum(0, makeFakeStream([{ readyState: 'ended' }]))
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(alertText()).toBe(jaEn('recording_start_failed'))
    // ended の track があるので、次の録音の開始で古い track を止めてから取り直す
    const stream2 = await startJaRecording()
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(stream2).not.toBe(stream)
    expect(jaStop()).toBeInTheDocument()
  })

  it('keeps microphone_denied for a getUserMedia rejection', async () => {
    renderPage()
    await tapJa()
    await act(async () => { await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(alertText()).toBe(jaEn('microphone_denied'))
    expect(console.warn).toHaveBeenCalledWith('[GoTalk] microphone error', { reason: 'NotAllowedError' })
    expect(jaTalk()).not.toBeDisabled()
  })

  it('keeps recording and sends to the backend when the level meter and the recognition fail (3.11-4)', async () => {
    setupSpeechRecognition({ throwOnCreate: true })
    Object.defineProperty(globalThis, 'AudioContext', { value: vi.fn(function () { throw new Error('x') }), writable: true, configurable: true })
    renderPage()
    await startJaRecording()
    expect(jaStop()).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await tapStop()
    await finishRecorder(0)
    expect(fetchCalls.map(c => c.url)).toEqual(['/api/interpret'])
  })
})

describe('InterpreterPage audio lifecycle: user stop', () => {
  it('sends after the last ondataavailable, and does not stop the tracks (3.11-5)', async () => {
    renderPage()
    const stream = await startJaRecording()
    act(() => { recorders.instances[0].ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await tapStop()
    // stopping：最後のデータを待っている間は、送らず、国旗も押せない
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(jaTalk()).toBeDisabled()
    await finishRecorder(0, 'cde')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const audio = (fetchCalls[0].options.body as FormData).get('audio') as Blob
    expect(audio.size).toBe(MIN_INTERPRET_AUDIO_BYTES + 3)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(isProcessing()).toBe(true)
  })

  it('does not restart the recognition on onend after the stop (3.11-7)', async () => {
    renderPage()
    await startJaRecording()
    const recognition = recognitions.instances[0]
    act(() => { recognition.onend?.() })
    expect(recognition.start).toHaveBeenCalledTimes(2)
    await tapStop()
    act(() => { recognition.onend?.() })
    await finishRecorder(0)
    act(() => { recognition.onend?.() })
    expect(recognition.start).toHaveBeenCalledTimes(2)
  })
})

describe('InterpreterPage audio lifecycle: user stop edge cases (JJ1)', () => {
  it('waits for onstop and sends the whole recording when the recorder has become inactive by itself', async () => {
    renderPage()
    const stream = await startJaRecording()
    recorders.instances[0].state = 'inactive'
    await tapStop()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(jaTalk()).toBeDisabled()
    await finishRecorder(0)
    expect(fetchCalls.map(c => c.url)).toEqual(['/api/interpret'])
    expect(((fetchCalls[0].options.body as FormData).get('audio') as Blob).size).toBe(MIN_INTERPRET_AUDIO_BYTES)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })

  it('does not send, does not stop the tracks, shows recording_failed, and returns to idle when stop() throws', async () => {
    renderPage()
    const stream = await startJaRecording()
    act(() => { recorders.instances[0].ondataavailable?.({ data: new Blob(['part']) }) })
    recorders.instances[0].stop.mockImplementation(() => { throw new DOMException('x', 'InvalidStateError') })
    await tapStop()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(alertText()).toBe(jaEn('recording_failed'))
    expect(jaTalk()).not.toBeDisabled()
    await finishRecorder(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('InterpreterPage audio lifecycle: onstop watchdog (JJ2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not stop the tracks, shows recording_failed, and returns to idle when onstop does not arrive within RECORDER_STOP_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage()
    const stream = await startJaRecording()
    await tapStop()
    expect(jaTalk()).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS) })
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(alertText()).toBe(jaEn('recording_failed'))
    expect(jaTalk()).not.toBeDisabled()
    await finishRecorder(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('InterpreterPage audio lifecycle: the recording stops by itself (JJ5)', () => {
  it('shows recording_failed, returns to idle, does not send, and acquires again on the next start when the track ends while recording', async () => {
    renderPage()
    const stream = await startJaRecording()
    await act(async () => {
      endTrack(stream.tracks[0])
      recorders.instances[0].state = 'inactive'
      recorders.instances[0].ondataavailable?.({ data: new Blob(['part']) })
      recorders.instances[0].onstop?.()
    })
    expect(alertText()).toBe(jaEn('recording_failed'))
    expect(jaStop()).not.toBeInTheDocument()
    expect(jaTalk()).not.toBeDisabled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    // 次の録音の開始で、ended の track を止めてから取り直す
    const stream2 = await startJaRecording()
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(stream2.tracks[0].stop).not.toHaveBeenCalled()
    expect(jaStop()).toBeInTheDocument()
  })

  it('sends normally when the track ends after the user stop', async () => {
    renderPage()
    const stream = await startJaRecording()
    await tapStop()
    act(() => { endTrack(stream.tracks[0]) })
    await finishRecorder(0)
    expect(fetchCalls.map(c => c.url)).toEqual(['/api/interpret'])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('InterpreterPage audio lifecycle: interruption', () => {
  it('does not send, does not stop the tracks, and returns to idle when hidden while recording (3.11-6)', async () => {
    renderPage()
    const stream = await startJaRecording()
    act(() => { recorders.instances[0].ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => { setVisibility('hidden') })
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(jaStop()).not.toBeInTheDocument()
    expect(jaTalk()).not.toBeDisabled()
    // 後から来た onstop は何もしない
    await finishRecorder(0)
    expect(fetchMock).not.toHaveBeenCalled()
    // visible に戻っても、自動ではマイクを開かない
    await act(async () => { setVisibility('visible') })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('does not restart the recognition on onend after hidden (3.11-7)', async () => {
    renderPage()
    await startJaRecording()
    const recognition = recognitions.instances[0]
    await act(async () => { setVisibility('hidden') })
    act(() => { recognition.onend?.() })
    expect(recognition.start).toHaveBeenCalledTimes(1)
    expect(recognition.stop).toHaveBeenCalledTimes(1)
  })

  it('aborts while stopping without sending', async () => {
    renderPage()
    await startJaRecording()
    await tapStop()
    await act(async () => { setVisibility('hidden') })
    await finishRecorder(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jaTalk()).not.toBeDisabled()
  })

  it('survives repeated cleanups without exceptions or double stops (3.11-8)', async () => {
    const { unmount } = renderPage()
    const stream = await startJaRecording()
    await act(async () => {
      setVisibility('hidden')
      firePageTransition('pagehide', false)
      fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' }))
    })
    unmount()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })

  it('cleans up and shows recording_failed when MediaRecorder reports an error while recording', async () => {
    renderPage()
    const stream = await startJaRecording()
    await act(async () => { recorders.instances[0].onerror?.({}) })
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(alertText()).toBe(jaEn('recording_failed'))
    expect(jaTalk()).not.toBeDisabled()
    await finishRecorder(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('InterpreterPage audio lifecycle: stale callbacks (3.11-11)', () => {
  it('shares the pending getUserMedia of session 1 with session 2, and only session 2 records with it', async () => {
    renderPage()
    await tapJa()
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    await tapJa()
    // 待っている getUserMedia を、2回目の開始でも使う（2回呼ばない）
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const stream = await resolveGum(0)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances).toHaveLength(1)
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    expect(jaStop()).toBeInTheDocument()
  })

  it('ignores the late onstop, data, and onend of session 1 while session 2 records', async () => {
    renderPage()
    const stream1 = await startJaRecording()
    const [recorder1] = recorders.instances
    const [recognition1] = recognitions.instances
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    const stream2 = await startJaRecording()
    // 同じマイクを使い回す
    expect(stream2).toBe(stream1)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const recorder2 = recorders.instances[1]

    await act(async () => {
      recorder1.ondataavailable?.({ data: new Blob(['old-data']) })
      recorder1.onstop?.()
      recognition1.onresult?.({ results: [[{ transcript: '古い発話' }]] })
      recognition1.onend?.()
    })
    expect(jaStop()).toBeInTheDocument()
    expect(recorder2.stop).not.toHaveBeenCalled()
    expect(stream1.tracks[0].stop).not.toHaveBeenCalled()
    expect(recognition1.start).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(document.querySelector('.source-card__text')?.textContent).toBe('')

    await tapStop()
    await finishRecorder(1, `new${AUDIO_DATA}`)
    expect(fetchCalls).toHaveLength(1)
    expect(((fetchCalls[0].options.body as FormData).get('audio') as Blob).size).toBe(MIN_INTERPRET_AUDIO_BYTES + 3)
  })
})

describe('InterpreterPage audio lifecycle: TTS', () => {
  it('lets the speak button be pressed only in ready (3.11-9)', async () => {
    const { AudioCtor, source } = setupAudio()
    renderPage()
    expect(speakButton()).not.toBeInTheDocument()
    await reachReady()
    expect(speakButton()).not.toBeDisabled()
    // processing（編集した文の再翻訳）の間は押せない
    await editAndRetranslate('Edited')
    expect(isProcessing()).toBe(true)
    expect(speakButton()).toBeDisabled()
    // 前の翻訳の結果が残る失敗では、ready に戻って押せる
    await resolveFetch(1, errorResponse(500, {}))
    expect(alertText()).toBe(jaEn('generic_error'))
    expect(speakButton()).not.toBeDisabled()
    // speaking の間は押せない
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(speakButton()).toBeDisabled()
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(fetchCalls.filter(c => c.url === '/api/tts')).toHaveLength(1)
    await resolveFetch(2, audioResponse())
    await act(async () => { await Promise.resolve() })
    expect(source()?.start).toHaveBeenCalledTimes(1)
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('stops the reading, disconnects the source, and returns to ready when hidden while speaking (3.11-13)', async () => {
    renderPage()
    const { source } = await reachSpeaking()
    const onended = source.onended
    expect(speakButton()).toBeDisabled()
    await act(async () => { setVisibility('hidden') })
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(source.onended).toBeNull()
    expect(speakButton()).not.toBeDisabled()
    expect(translationText()).toBe('こんにちは')
    // 後から来た onended は何もしない
    await editAndRetranslate('Edited')
    expect(isProcessing()).toBe(true)
    act(() => { onended?.() })
    expect(isProcessing()).toBe(true)
    expect(source.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the reading, disconnects the source, and returns to ready on pagehide while speaking (3.11-17)', async () => {
    renderPage()
    const { source } = await reachSpeaking()
    await act(async () => { firePageTransition('pagehide', false) })
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(speakButton()).not.toBeDisabled()
  })

  it.each([
    ['back', () => fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' }))],
  ])('stops the reading on %s while speaking', async (_, leave) => {
    renderPage()
    const { source } = await reachSpeaking()
    await act(async () => { leave() })
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
  })

  it('stops the reading and closes the TTS AudioContext on unmount while speaking', async () => {
    const { unmount } = renderPage()
    const { source, instances } = await reachSpeaking()
    const ctx = ttsContextOf(instances)!
    unmount()
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
  })

  it('aborts /api/tts and does not play the late audio when hidden before the audio arrives', async () => {
    const { instances, AudioCtor } = setupAudio()
    renderPage()
    await reachReady()
    await act(async () => { fireEvent.click(speakButton()!) })
    const tts = fetchCalls[1]
    await act(async () => { setVisibility('hidden') })
    expect(tts.options.signal?.aborted).toBe(true)
    expect(speakButton()).not.toBeDisabled()
    await resolveFetch(1, audioResponse())
    await act(async () => { await Promise.resolve() })
    const ctx = ttsContextOf(instances)!
    expect(ctx.decodeAudioData).not.toHaveBeenCalled()
    expect(ctx.createBufferSource).not.toHaveBeenCalled()
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('stops the reading when the source text is edited while speaking', async () => {
    renderPage()
    const { source } = await reachSpeaking()
    const onended = source.onended
    await editAndRetranslate('Edited')
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(isProcessing()).toBe(true)
    act(() => { onended?.() })
    expect(isProcessing()).toBe(true)
  })
})

describe('InterpreterPage audio lifecycle: translation requests', () => {
  it('keeps processing when hidden, and shows the result when it comes (3.11-12)', async () => {
    renderPage()
    await startJaRecording()
    await tapStop()
    await finishRecorder(0)
    await act(async () => { setVisibility('hidden') })
    expect(isProcessing()).toBe(true)
    expect(jaTalk()).toBeDisabled()
    expect(fetchCalls[0].options.signal?.aborted).toBe(false)
    await act(async () => { setVisibility('visible') })
    await resolveFetch(0, okResponse(interpretResult('結果')))
    expect(translationText()).toBe('結果')
    expect(speakButton()).not.toBeDisabled()
  })

  it('aborts the request on back and does not use the late result (3.11-12)', async () => {
    const { onBack } = renderPage()
    await startJaRecording()
    await tapStop()
    await finishRecorder(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' })) })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(fetchCalls[0].options.signal?.aborted).toBe(true)
    await resolveFetch(0, okResponse(interpretResult('古い結果')))
    expect(translationText()).not.toBe('古い結果')
    expect(document.querySelector('.history-item')).not.toBeInTheDocument()
  })

  it('aborts the request on pagehide, returns to idle, and ignores the late result (3.11-15)', async () => {
    renderPage()
    await startJaRecording()
    await tapStop()
    await finishRecorder(0)
    await act(async () => { firePageTransition('pagehide', false) })
    expect(fetchCalls[0].options.signal?.aborted).toBe(true)
    expect(isProcessing()).toBe(false)
    expect(jaTalk()).not.toBeDisabled()
    await resolveFetch(0, okResponse(interpretResult('古い結果')))
    expect(translationText()).not.toBe('古い結果')
    expect(speakButton()).not.toBeInTheDocument()
  })

  it('ignores the late failure after pagehide (3.11-15)', async () => {
    renderPage()
    await startJaRecording()
    await tapStop()
    await finishRecorder(0)
    await act(async () => { firePageTransition('pagehide', false) })
    await act(async () => { fetchCalls[0].reject(new DOMException('Aborted', 'AbortError')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(console.warn).not.toHaveBeenCalledWith('[GoTalk] API error', expect.anything())
  })

  it('ignores the late result of an edited retranslation after pagehide', async () => {
    renderPage()
    await reachReady()
    await editAndRetranslate('Edited')
    await act(async () => { firePageTransition('pagehide', false) })
    expect(fetchCalls[1].options.signal?.aborted).toBe(true)
    await resolveFetch(1, okResponse({ translatedText: '新しい訳', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }))
    expect(translationText()).not.toBe('新しい訳')
  })

  // back の後は画面が外れ（状態は processing のまま）、同じ画面で問い合わせ2を始められないため、
  // 問い合わせ1を止めるのは pagehide にする（back で止めた問い合わせの結果を使わないことは、3.11-12 で確かめる）
  it('shows only the result of request 2 when request 1 returns late after it was stopped (3.11-16)', async () => {
    renderPage()
    await startJaRecording()
    await tapStop()
    await finishRecorder(0)
    await act(async () => { firePageTransition('pagehide', false) })
    await startJaRecording()
    await tapStop()
    await finishRecorder(1)
    expect(fetchCalls).toHaveLength(2)
    await resolveFetch(0, okResponse(interpretResult('結果1')))
    expect(isProcessing()).toBe(true)
    await resolveFetch(1, okResponse(interpretResult('結果2')))
    expect(translationText()).toBe('結果2')
    expect([...document.querySelectorAll('.history-item__translation')].map(e => e.textContent)).toEqual(['結果2'])
  })
})

describe('InterpreterPage audio lifecycle: bfcache (3.11-18)', () => {
  // pagehide（persisted）と pageshow（persisted）を、同じ処理の中で続けて起こす
  async function hideAndShow() {
    await act(async () => {
      firePageTransition('pagehide', true)
      firePageTransition('pageshow', true)
    })
  }

  it.each([
    ['starting', async () => { await tapJa() }],
    ['recording', async () => { await startJaRecording() }],
    ['stopping', async () => { await startJaRecording(); await tapStop() }],
    ['processing', async () => { await startJaRecording(); await tapStop(); await finishRecorder(0) }],
  ])('restores %s to idle without opening the microphone or sending', async (_, reach) => {
    renderPage()
    await reach()
    const gumCalls = gum.getUserMedia.mock.calls.length
    const fetches = fetchMock.mock.calls.length
    await hideAndShow()
    expect(jaTalk()).not.toBeDisabled()
    expect(jaStop()).not.toBeInTheDocument()
    expect(isProcessing()).toBe(false)
    expect(speakButton()).not.toBeInTheDocument()
    expect(gum.getUserMedia.mock.calls.length).toBe(gumCalls)
    expect(fetchMock.mock.calls.length).toBe(fetches)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['ready', async () => { setupAudio(); await reachReady() }],
    ['speaking', async () => { await reachSpeaking() }],
  ])('restores %s to ready', async (_, reach) => {
    renderPage()
    await reach()
    const fetches = fetchMock.mock.calls.length
    await hideAndShow()
    expect(speakButton()).not.toBeDisabled()
    expect(jaTalk()).not.toBeDisabled()
    expect(translationText()).toBe('こんにちは')
    expect(fetchMock.mock.calls.length).toBe(fetches)
  })

  it('restores the recorded status even when the screen is still processing at pageshow', async () => {
    renderPage()
    await reachReady()
    // 編集した文が language_mismatch になり、原文を残したまま idle になる
    await editAndRetranslate('Unclear')
    await resolveFetch(1, errorResponse(422, { error: 'language_mismatch' }))
    expect(speakButton()).not.toBeInTheDocument()
    await act(async () => { firePageTransition('pagehide', true) })
    // pagehide の後に、わざと processing にしてから pageshow を起こす
    await editAndRetranslate('Unclear again')
    expect(isProcessing()).toBe(true)
    const fetches = fetchMock.mock.calls.length
    await act(async () => { firePageTransition('pageshow', true) })
    expect(isProcessing()).toBe(false)
    expect(jaTalk()).not.toBeDisabled()
    expect(fetchCalls[2].options.signal?.aborted).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[GoTalk] unexpected_active_session_after_pageshow')
    expect(fetchMock.mock.calls.length).toBe(fetches)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    await resolveFetch(2, okResponse({ translatedText: '遅い訳', backTranslation: '', sourceLanguage: 'en', targetLanguage: 'ja' }))
    expect(translationText()).not.toBe('遅い訳')
  })

  it('does nothing on a pageshow that is not persisted', async () => {
    renderPage()
    await reachReady()
    await act(async () => { firePageTransition('pagehide', true) })
    await editAndRetranslate('Edited')
    expect(isProcessing()).toBe(true)
    await act(async () => { firePageTransition('pageshow', false) })
    expect(isProcessing()).toBe(true)
    expect(fetchCalls[1].options.signal?.aborted).toBe(false)
    expect(console.warn).not.toHaveBeenCalledWith('[GoTalk] unexpected_active_session_after_pageshow')
  })

  it('does nothing on a persisted pageshow without a pagehide', async () => {
    renderPage()
    await reachReady()
    await act(async () => { firePageTransition('pageshow', true) })
    expect(speakButton()).not.toBeDisabled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('starts session 2 normally after bfcache, and ignores the late callbacks of session 1 (18-b)', async () => {
    renderPage()
    const stream1 = await startJaRecording()
    const [recorder1] = recorders.instances
    const [recognition1] = recognitions.instances
    await hideAndShow()
    expect(stream1.tracks[0].stop).not.toHaveBeenCalled()
    expect(jaTalk()).not.toBeDisabled()

    const stream2 = await startJaRecording()
    expect(stream2).toBe(stream1)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(jaStop()).toBeInTheDocument()
    await act(async () => {
      recorder1.ondataavailable?.({ data: new Blob(['old-data']) })
      recorder1.onstop?.()
      recognition1.onend?.()
    })
    expect(jaStop()).toBeInTheDocument()
    expect(recorders.instances[1].stop).not.toHaveBeenCalled()
    expect(stream2.tracks[0].stop).not.toHaveBeenCalled()
    expect(recognition1.start).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    await tapStop()
    await finishRecorder(1, `new${AUDIO_DATA}`)
    expect(((fetchCalls[0].options.body as FormData).get('audio') as Blob).size).toBe(MIN_INTERPRET_AUDIO_BYTES + 3)
  })

  it('shares the late getUserMedia of session 1 with session 2 after bfcache (18-b)', async () => {
    renderPage()
    await tapJa()
    await hideAndShow()
    await tapJa()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const stream = await resolveGum(0)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances).toHaveLength(1)
    expect(jaStop()).toBeInTheDocument()
  })
})
