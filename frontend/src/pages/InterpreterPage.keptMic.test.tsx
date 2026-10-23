import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import {
  AUDIO_GLOBALS, endTrack, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder, setupSpeechRecognition,
  ttsContextOf,
} from '../test/audioMocks'
import type { FakeAudioContext, FakeStream } from '../test/audioMocks'

// マイクを開いたまま使い回すこと、読み上げを AudioContext で鳴らすこと、マイクの音が来ないときの検出
// （docs/speech-flow.md）。実験のスイッチがないときは useKeptAudioSession、あるときは useAudioSession を使う

const [ja, en] = LANGUAGES
const jaEn = (key: MessageKey) => getLocalizedMessage(key, 'ja', 'en')
const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let audioContexts: FakeAudioContext[]
let AudioCtor: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.spyOn>
let resolvedGum: number
let streams: FakeStream[]
// Date.now() の値（録音の長さを決めるため）
let clock: number

function interpretResponse(translatedText = 'こんにちは'): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text: 'Hello', translatedText, ttsText: translatedText, backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
  } as unknown as Response
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  resolvedGum = 0
  streams = []
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  audioContexts = setupAudioContext().instances
  AudioCtor = vi.fn()
  Object.defineProperty(globalThis, 'Audio', { value: AudioCtor, writable: true, configurable: true })
  clock = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
    String(url) === '/api/tts' ? makeTtsOkResponse() : interpretResponse()
  ))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

function renderPage(experiment?: ExperimentConfig) {
  return render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
}

const jaTalk = () => screen.getByRole('button', { name: 'Japaneseで話す' })
const jaStop = () => screen.queryByRole('button', { name: 'Japaneseの録音を停止' })
const speakButton = () => screen.queryByRole('button', { name: '発声する' })
const alertText = () => screen.queryByRole('alert')?.textContent
const interpretCalls = () => fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]) === '/api/interpret')
const ttsCalls = () => fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]) === '/api/tts')
const ttsContext = () => ttsContextOf(audioContexts)!
const lastSource = () => ttsContext().bufferSources.at(-1)!

async function flush() {
  await act(async () => { await Promise.resolve() })
}

// 日本語の国旗をタップし、まだ終わらせていない getUserMedia があれば終わらせて recording にする
async function startRecording() {
  await act(async () => { fireEvent.click(jaTalk()) })
  if (gum.calls.length > resolvedGum) {
    const index = resolvedGum
    resolvedGum += 1
    let stream: FakeStream | undefined
    await act(async () => { stream = await gum.calls[index].resolve() })
    streams.push(stream!)
  }
  expect(jaStop()).toBeInTheDocument()
}

// 止めて、MediaRecorder の最後のデータと onstop を起こす。durationMs は、録音の成立から止めるまでの時間
async function stopRecording(data = AUDIO_DATA, durationMs = 2000) {
  clock += durationMs
  const recorder = recorders.instances.at(-1)!
  await act(async () => { fireEvent.click(jaStop()!) })
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob([data]) })
    recorder.onstop?.()
  })
  await flush()
}

async function recordAndTranslate() {
  await startRecording()
  await stopRecording()
  await waitFor(() => expect(speakButton()).not.toBeDisabled())
}

// 読み上げを始め、再生（AudioBufferSourceNode の start()）まで進める
async function speak() {
  await act(async () => { fireEvent.click(speakButton()!) })
  await flush()
  await flush()
}

async function speakToEnd() {
  await speak()
  const source = lastSource()
  expect(source.start).toHaveBeenCalledTimes(1)
  act(() => { source.onended?.() })
  expect(speakButton()).not.toBeDisabled()
}

async function copyJson(): Promise<{ kind: string; diagnostics: { sessions: { getUserMedia: { acquired: boolean; reused: boolean } }[]; events: { type: string }[]; experiment?: unknown; keptMic?: { getUserMediaCalls: number; endedEvents: { at: number; track: number }[] } } }> {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { writes.push(text) }) }, configurable: true })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return JSON.parse(writes.at(-1)!)
}

const eventTypes = async () => (await copyJson()).diagnostics.events.map(e => e.type)

describe('InterpreterPage kept microphone', () => {
  it('calls getUserMedia only once for 10 recordings, with readings after the 3rd and the 7th', async () => {
    renderPage()
    for (let i = 1; i <= 10; i++) {
      await recordAndTranslate()
      if (i === 3 || i === 7) await speakToEnd()
    }
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(streams).toHaveLength(1)
    expect(streams[0].tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances).toHaveLength(10)
    expect(interpretCalls()).toHaveLength(10)
    // 3回目と7回目の翻訳は同じ文字なので、7回目の後の読み上げは取っておいた音声を使う（/api/tts は1回、鳴らすのは2回）
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('starts MediaRecorder in the tap itself when the microphone is reused', async () => {
    renderPage()
    await recordAndTranslate()
    // act の外で、タップの同期の処理だけを進める
    fireEvent.click(jaTalk())
    expect(recorders.instances).toHaveLength(2)
    expect(recorders.instances[1].start).toHaveBeenCalledTimes(1)
    await flush()
    expect(jaStop()).toBeInTheDocument()
  })

  it('uses the kept session with an empty exp, and puts the logEvent records into the copied JSON', async () => {
    renderPage(readExperimentConfig('?exp='))
    await startRecording()
    await act(async () => { recognitions.instances[0].onresult?.({ results: [[{ transcript: '聞かれたくない本文' }]] }) })
    await stopRecording()
    await waitFor(() => expect(speakButton()).not.toBeDisabled())
    await startRecording()
    await stopRecording()
    await waitFor(() => expect(speakButton()).not.toBeDisabled())
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const json = await copyJson()
    expect(json.kind).toBe('audioSession')
    expect(json.diagnostics.experiment).toBeUndefined()
    expect(json.diagnostics.sessions.map(s => [s.getUserMedia.acquired, s.getUserMedia.reused])).toEqual([[true, false], [false, true]])
    const types = json.diagnostics.events.map(e => e.type)
    expect(types).toContain('status:recording')
    expect(types).toContain('get_user_media_start')
    expect(types).toContain('microphone_reused')
    expect(types).toContain('recording_stopped')
    expect(JSON.stringify(json)).not.toContain('聞かれたくない本文')
  })

  it('puts keptMic into the copied JSON with an empty exp (the new session without an experiment switch)', async () => {
    vi.mocked(Date.now).mockImplementation(() => 7000)
    renderPage(readExperimentConfig('?exp='))
    await recordAndTranslate()
    await recordAndTranslate()
    expect((await copyJson()).diagnostics.keptMic).toEqual({ getUserMediaCalls: 1, endedEvents: [] })
    act(() => { endTrack(streams[0].tracks[0]) })
    expect((await copyJson()).diagnostics.keptMic).toEqual({ getUserMediaCalls: 1, endedEvents: [{ at: 7000, track: 0 }] })
    // ended の後の録音で取り直すと、回数が増える
    await recordAndTranslate()
    expect((await copyJson()).diagnostics.keptMic?.getUserMediaCalls).toBe(2)
  })

  it('does not put keptMic into the copied JSON with a useAudioSession switch', async () => {
    renderPage(readExperimentConfig('?exp=trace'))
    await recordAndTranslate()
    expect((await copyJson()).diagnostics.keptMic).toBeUndefined()
  })

  it('uses useAudioSession with an experiment switch (getUserMedia and track stop() for every recording)', async () => {
    renderPage(readExperimentConfig('?exp=trace'))
    await recordAndTranslate()
    await recordAndTranslate()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(streams).toHaveLength(2)
    expect(streams[0].tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(streams[1].tracks[0].stop).toHaveBeenCalledTimes(1)
  })
})

describe('InterpreterPage TTS with AudioContext', () => {
  it('calls resume() in the tap before fetch, and plays with decodeAudioData and createBufferSource().start()', async () => {
    renderPage()
    await recordAndTranslate()
    await speak()
    const ctx = ttsContext()
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    const ttsFetchOrder = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.findIndex((c: unknown[]) => String(c[0]) === '/api/tts')]
    expect(ctx.resume.mock.invocationCallOrder[0]).toBeLessThan(ttsFetchOrder)
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1)
    const source = lastSource()
    expect(source.buffer).toEqual({ duration: 1 })
    expect(source.connect).toHaveBeenCalledWith(ctx.destination)
    expect(source.start).toHaveBeenCalledTimes(1)
    expect(speakButton()).toBeDisabled()
    act(() => { source.onended?.() })
    expect(speakButton()).not.toBeDisabled()
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('creates the AudioContext, calls resume(), and calls fetch(/api/tts) in this order in the tap itself (QQ6)', async () => {
    const { Ctor, instances } = setupAudioContext()
    audioContexts = instances
    renderPage()
    await recordAndTranslate()
    const ctorCallsBefore = Ctor.mock.calls.length
    // act も await も挟まずに、タップの同期の処理だけを進める
    fireEvent.click(speakButton()!)
    expect(Ctor.mock.calls.length).toBe(ctorCallsBefore + 1)
    const ctx = ttsContext()
    expect(ctx).toBe(instances.at(-1))
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect(ttsCalls()).toHaveLength(1)
    const ttsFetchOrder = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.findIndex((c: unknown[]) => String(c[0]) === '/api/tts')]
    const ctorOrder = Ctor.mock.invocationCallOrder.at(-1)!
    expect(ctorOrder).toBeLessThan(ctx.resume.mock.invocationCallOrder[0])
    expect(ctx.resume.mock.invocationCallOrder[0]).toBeLessThan(ttsFetchOrder)
    await flush()
    await flush()
  })

  it('calls resume() synchronously in the tap', async () => {
    renderPage()
    await recordAndTranslate()
    fireEvent.click(speakButton()!)
    expect(ttsContext().resume).toHaveBeenCalledTimes(1)
    await flush()
    await flush()
  })

  it('uses one AudioContext for the readings of the screen', async () => {
    renderPage()
    await recordAndTranslate()
    await speakToEnd()
    await speakToEnd()
    expect(audioContexts.filter(c => c.resume.mock.calls.length > 0)).toHaveLength(1)
    expect(ttsContext().resume).toHaveBeenCalledTimes(2)
    expect(ttsContext().close).not.toHaveBeenCalled()
  })

  // 出来事の名前を「コピー」の JSON で確かめるため、新しいセッションを使うとき（実験のスイッチがないとき）の ?exp= で描画する
  it.each([
    ['resume() rejects', { resumeRejects: true }, 'tts_resume_rejected:NotAllowedError'],
    ['resume() throws', { resumeThrows: true }, 'tts_resume_rejected:InvalidStateError'],
    ['the state is not running after resume()', { stateAfterResume: 'suspended' }, 'tts_resume_not_running:suspended'],
  ])('does not play and returns to ready without a message when %s', async (_, options, event) => {
    audioContexts = setupAudioContext(options).instances
    renderPage(readExperimentConfig('?exp='))
    await recordAndTranslate()
    await speak()
    expect(ttsContext().createBufferSource).not.toHaveBeenCalled()
    expect(speakButton()).not.toBeDisabled()
    expect(alertText()).toBeUndefined()
    expect(AudioCtor).not.toHaveBeenCalled()
    const types = await eventTypes()
    expect(types).toContain(event)
    expect(types.filter(t => t.startsWith('tts_resume_'))).toEqual([event])
  })

  it('does not call /api/tts, stays ready without a message, and tries again on the next tap when the AudioContext cannot be created', async () => {
    // 未処理の Promise の拒否を数える（テストは Node で動く。アプリの型には process がないので、ここだけで型を付ける）
    const nodeProcess = (globalThis as unknown as { process: { on: (type: string, f: () => void) => void; off: (type: string, f: () => void) => void } }).process
    const unhandled = vi.fn()
    nodeProcess.on('unhandledRejection', unhandled)
    try {
      setupAudioContext({ throwOnCreate: true })
      renderPage(readExperimentConfig('?exp='))
      await recordAndTranslate()
      await act(async () => { fireEvent.click(speakButton()!) })
      await flush()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(ttsCalls()).toHaveLength(0)
      expect(speakButton()).not.toBeDisabled()
      expect(alertText()).toBeUndefined()
      expect(AudioCtor).not.toHaveBeenCalled()
      expect(unhandled).not.toHaveBeenCalled()
      expect(await eventTypes()).toContain('tts_context_create_failed:Error')
      expect(console.warn).toHaveBeenCalledWith('[GoTalk] API error', expect.objectContaining({ endpoint: '/api/tts' }))
      // 次のタップで作れたら鳴る
      audioContexts = setupAudioContext().instances
      await speakToEnd()
      expect(ttsCalls()).toHaveLength(1)
      expect(AudioCtor).not.toHaveBeenCalled()
    } finally {
      nodeProcess.off('unhandledRejection', unhandled)
    }
  })

  it('does not let a late rejection of an old resume() change the new reading', async () => {
    const pending: { resolve: () => void; reject: (e: unknown) => void }[] = []
    audioContexts = setupAudioContext({
      resumeImpl: (ctx) => new Promise<void>((resolve, reject) => {
        pending.push({ resolve: () => { ctx.state = 'running'; resolve() }, reject })
      }),
    }).instances
    renderPage()
    await recordAndTranslate()
    // 読み上げ1は resume() を待っている間に、hidden で止まる
    await speak()
    expect(ttsContext().createBufferSource).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(speakButton()).not.toBeDisabled()
    // 読み上げ2
    await speak()
    await act(async () => { pending[1].resolve() })
    await flush()
    const source2 = lastSource()
    expect(source2.start).toHaveBeenCalledTimes(1)
    expect(speakButton()).toBeDisabled()
    // 読み上げ1の resume() が遅れて拒否されても、読み上げ2は続く
    await act(async () => { pending[0].reject(new DOMException('x', 'NotAllowedError')) })
    await flush()
    expect(speakButton()).toBeDisabled()
    expect(source2.stop).not.toHaveBeenCalled()
    expect(ttsContext().createBufferSource).toHaveBeenCalledTimes(1)
    act(() => { source2.onended?.() })
    expect(speakButton()).not.toBeDisabled()
  })

  it('returns to ready with the watchdog when onended does not arrive, and logs tts_ended_timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    audioContexts = setupAudioContext({ bufferDuration: 2 }).instances
    renderPage(readExperimentConfig('?exp='))
    await recordAndTranslate()
    await speak()
    const source = lastSource()
    expect(source.start).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(4_900) })
    expect(speakButton()).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(speakButton()).not.toBeDisabled()
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(alertText()).toBeUndefined()
    expect(await eventTypes()).toContain('tts_ended_timeout')
  })

  it('clears the watchdog when onended arrives (no tts_ended_timeout)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage(readExperimentConfig('?exp='))
    await recordAndTranslate()
    // 録音中の画面が消えた後の盾（400ms）のタイマーを終わらせてから、見張りのタイマーだけを数える
    await act(async () => { vi.advanceTimersByTime(400) })
    await speak()
    expect(vi.getTimerCount()).toBe(1)
    act(() => { lastSource().onended?.() })
    // 見張りのタイマーが解除されている
    expect(vi.getTimerCount()).toBe(0)
    expect(speakButton()).not.toBeDisabled()
    // 次の読み上げを始めた後に、前の読み上げの見張りの時間を過ぎても、何も変わらない
    await speak()
    await act(async () => { vi.advanceTimersByTime(3_500) })
    expect(speakButton()).toBeDisabled()
    act(() => { lastSource().onended?.() })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(speakButton()).not.toBeDisabled()
    expect(await eventTypes()).not.toContain('tts_ended_timeout')
  })

  it('returns to ready without a message when decodeAudioData fails', async () => {
    audioContexts = setupAudioContext({ decodeRejects: true }).instances
    renderPage()
    await recordAndTranslate()
    await speak()
    expect(ttsContext().createBufferSource).not.toHaveBeenCalled()
    expect(speakButton()).not.toBeDisabled()
    expect(alertText()).toBeUndefined()
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('returns to ready without a message when start() throws', async () => {
    audioContexts = setupAudioContext({ startThrows: true }).instances
    renderPage()
    await recordAndTranslate()
    await speak()
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(lastSource().disconnect).toHaveBeenCalledTimes(1)
    expect(speakButton()).not.toBeDisabled()
    expect(alertText()).toBeUndefined()
    expect(AudioCtor).not.toHaveBeenCalled()
  })

  it('shows the message of an ApiError from /api/tts', async () => {
    renderPage()
    await recordAndTranslate()
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: () => Promise.resolve({ error: 'x', code: 'upstream_busy' }) }) as unknown as Response)
    await speak()
    expect(speakButton()).not.toBeDisabled()
    expect(alertText()).toBe(jaEn('upstream_busy'))
    expect(ttsContext().decodeAudioData).not.toHaveBeenCalled()
  })
})

describe('InterpreterPage no audio detection', () => {
  it.each([
    ['without exp (useKeptAudioSession)', '?exp='],
    ['with an experiment switch (useAudioSession)', '?exp=trace'],
  ])('does not send and shows microphone_no_audio for 1 second or longer without data or transcript, %s', async (_, search) => {
    renderPage(readExperimentConfig(search))
    await startRecording()
    await stopRecording('abcde', 1000)
    expect(interpretCalls()).toHaveLength(0)
    expect(alertText()).toBe(jaEn('microphone_no_audio'))
    expect(jaStop()).not.toBeInTheDocument()
    expect(jaTalk()).not.toBeDisabled()
    expect(await eventTypes()).toContain('no_audio_detected:bytes=5,ms=1000')
  })

  it.each([
    ['without exp (useKeptAudioSession)', undefined],
    ['with an experiment switch (useAudioSession)', '?exp=trace'],
  ])('does not send and shows recording_failed for less than 1 second, %s', async (_, search) => {
    renderPage(search === undefined ? undefined : readExperimentConfig(search))
    await startRecording()
    await stopRecording('abcde', 999)
    expect(interpretCalls()).toHaveLength(0)
    expect(alertText()).toBe(jaEn('recording_failed'))
    expect(jaTalk()).not.toBeDisabled()
  })

  it('sends a small recording when the recognition has the text', async () => {
    renderPage()
    await startRecording()
    await act(async () => { recognitions.instances[0].onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
    await stopRecording('abcde', 3000)
    expect(interpretCalls()).toHaveLength(1)
    expect(((interpretCalls()[0][1] as RequestInit).body as FormData).get('transcript')).toBe('こんにちは')
    expect(alertText()).toBeUndefined()
  })

  it('sends a recording of MIN_INTERPRET_AUDIO_BYTES, and not of one byte less', async () => {
    renderPage()
    await startRecording()
    await stopRecording('a'.repeat(MIN_INTERPRET_AUDIO_BYTES), 3000)
    expect(interpretCalls()).toHaveLength(1)
    await waitFor(() => expect(speakButton()).not.toBeDisabled())
    await startRecording()
    await stopRecording('a'.repeat(MIN_INTERPRET_AUDIO_BYTES - 1), 3000)
    expect(interpretCalls()).toHaveLength(1)
    expect(alertText()).toBe(jaEn('microphone_no_audio'))
  })

  it('records again after microphone_no_audio, with the same microphone', async () => {
    renderPage()
    await startRecording()
    await stopRecording('', 5000)
    expect(alertText()).toBe(jaEn('microphone_no_audio'))
    await startRecording()
    await stopRecording()
    expect(interpretCalls()).toHaveLength(1)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
  })
})
