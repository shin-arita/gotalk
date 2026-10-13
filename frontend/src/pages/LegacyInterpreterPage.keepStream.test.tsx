import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import LegacyInterpreterPage from './LegacyInterpreterPage'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import { MAX_INTERPRET_AUDIO_BYTES } from '../api'
import { getLocalizedMessage } from '../messages'
import {
  AUDIO_GLOBALS, endTrack, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// 3回目の実験の legacykeep（legacy に、マイクの使い回しだけを加えたもの。docs/testing.md の「実験のスイッチ」）

const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let contexts: ReturnType<typeof setupAudioContext>
let frames: ReturnType<typeof setupAnimationFrame>

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  contexts = setupAudioContext()
  frames = setupAnimationFrame()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
  } as unknown as Response)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

const keepConfig = () => readExperimentConfig('?exp=legacykeep')

function renderLegacy(experiment?: ExperimentConfig) {
  return render(<LegacyInterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
}

// 録音を1回する。stream を渡したときは、getUserMedia の待ちを、その stream で解く（使い回すときは渡さない）
async function recordOnce(index: number, chunks: string[], options: { stream?: FakeStream; beforeStop?: () => void } = {}) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
  if (options.stream) {
    const pending = gum.calls[gum.calls.length - 1]
    await act(async () => { await pending.resolve(options.stream) })
  }
  const recorder = recorders.instances[index]
  options.beforeStop?.()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
  await act(async () => {
    chunks.forEach(c => recorder.ondataavailable?.({ data: new Blob([c]) }))
    recorder.onstop?.()
  })
  await act(async () => { await Promise.resolve() })
}

async function copyJson() {
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { copied = text }) }, configurable: true })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return JSON.parse(copied)
}

describe('LegacyInterpreterPage with exp=legacykeep', () => {
  it('calls getUserMedia once and does not stop the track after the first recording', async () => {
    renderLegacy(keepConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['abc'], { stream })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    // 翻訳の結果は、今までどおり出る
    expect(document.querySelector('.translation-card__text')).toHaveTextContent('こんにちは')
  })

  it('reuses the same stream for the second and third recordings without getUserMedia', async () => {
    renderLegacy(keepConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    await recordOnce(2, ['c'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorders.Ctor).toHaveBeenCalledTimes(3)
    const streams = (recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c[0])
    expect(streams).toEqual([stream, stream, stream])
    // 音量の取得の AudioContext は、録音ごとに使い回す stream から作って閉じる
    expect(contexts.instances).toHaveLength(3)
    contexts.instances.forEach(ctx => {
      expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream)
      expect(ctx.close).toHaveBeenCalledTimes(1)
    })
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    // 3回とも翻訳に送る
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(c => c[0] === '/api/interpret')).toHaveLength(3)
  })

  it('calls getUserMedia again when the held track has ended', async () => {
    renderLegacy(keepConfig())
    const first = makeFakeStream()
    await recordOnce(0, ['a'], { stream: first })
    endTrack(first.tracks[0])
    const second = makeFakeStream()
    await recordOnce(1, ['b'], { stream: second })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toBe(second)
    // 古い track は、getUserMedia を呼ぶ前に止める
    expect(first.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(first.tracks[0].stop.mock.invocationCallOrder[0]).toBeLessThan(gum.getUserMedia.mock.invocationCallOrder[1])
    // 次の録音では、新しい stream を使い回す
    await recordOnce(2, ['c'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[2][0]).toBe(second)
    const json = await copyJson()
    expect(json.recordings.map((r: { keepStream: unknown }) => r.keepStream)).toEqual([
      expect.objectContaining({ streamReused: false, getUserMediaCalls: 1, trackStates: [] }),
      expect.objectContaining({ streamReused: false, getUserMediaCalls: 2, trackStates: ['ended/enabled/unmuted'] }),
      expect.objectContaining({ streamReused: true, getUserMediaCalls: 2, trackStates: ['live/enabled/unmuted'] }),
    ])
  })

  it('stops the track when the screen goes away', async () => {
    const { unmount } = renderLegacy(keepConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    unmount()
    expect(stream.tracks[0].stop).toHaveBeenCalled()
  })

  it('creates and stops the recognition for each recording as before', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await recordOnce(1, ['b'])
    expect(recognitions.instances).toHaveLength(2)
    recognitions.instances.forEach(r => {
      expect(r.start).toHaveBeenCalledTimes(1)
      expect(r.stop).toHaveBeenCalledTimes(1)
    })
  })

  it('records streamReused, the getUserMedia count, the track states and the RMS', async () => {
    renderLegacy(keepConfig())
    // 1回目：無音の tick が1回と、音のある tick（振幅 0.5 の矩形波）が1回
    await recordOnce(0, ['ab'], {
      stream: makeFakeStream(),
      beforeStop: () => {
        contexts.instances[0].analyser.getByteTimeDomainData.mockImplementationOnce((data: Uint8Array) => { data.fill(128) })
        act(() => { frames.frame(16) })
        act(() => { frames.frame(32) })
      },
    })
    // 2回目：無音の tick だけ
    await recordOnce(1, ['cd'], {
      beforeStop: () => {
        contexts.instances[1].analyser.getByteTimeDomainData.mockImplementation((data: Uint8Array) => { data.fill(128) })
        act(() => { frames.frame(16) })
      },
    })
    const json = await copyJson()
    expect(json.effective).toEqual(['legacykeep'])
    expect(json.recordings).toHaveLength(2)
    const audioContext = { audioContextState: 'running', audioContextFirstTickState: 'running', audioContextError: null }
    expect(json.recordings[0].keepStream).toEqual({
      streamReused: false, getUserMediaCalls: 1, trackStates: [], rmsMax: 0.5, rmsNonZeroSamples: 1, rmsSamples: 2, ...audioContext, transcriptSent: false,
    })
    expect(json.recordings[1].keepStream).toEqual({
      streamReused: true, getUserMediaCalls: 1, trackStates: ['live/enabled/unmuted'], rmsMax: 0, rmsNonZeroSamples: 0, rmsSamples: 1, ...audioContext, transcriptSent: false,
    })
    // legacy と同じ記録も残る
    expect(json.recordings[1].blobSize).toBe(2)
  })

  it('shows the keepStream values only when 更新 is pressed', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['ab'], { stream: makeFakeStream(), beforeStop: () => { act(() => { frames.frame(16) }) } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    const snapshot = screen.getByTestId('experiment-snapshot')
    expect(snapshot).toHaveTextContent('（legacykeep）')
    expect(snapshot).toHaveTextContent('マイク=getUserMedia（呼んだ回数の合計=1、track=-）、RMS 最大=0.500、0 でない回数=1/1、AudioContext=running→running、音声認識の文字=付けていない')
    await recordOnce(1, ['cd'])
    // 押すまでは変わらない
    expect(snapshot).not.toHaveTextContent('使い回し')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('マイク=使い回し（呼んだ回数の合計=1、track=live/enabled/unmuted）、RMS 最大=0.000、0 でない回数=0/0、AudioContext=running→-')
  })

  it('keeps the recording working when getUserMedia fails after the track has ended', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(keepConfig())
    const first = makeFakeStream()
    await recordOnce(0, ['a'], { stream: first })
    endTrack(first.tracks[0])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    // 古い track は、getUserMedia を呼ぶ前に止める
    expect(first.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(first.tracks[0].stop.mock.invocationCallOrder[0]).toBeLessThan(gum.getUserMedia.mock.invocationCallOrder[1])
    await act(async () => { await gum.calls[1].reject(new DOMException('denied', 'NotAllowedError')) })
    // 選んだ2つの言語（日本語と英語）の microphone_denied の文
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(getLocalizedMessage('microphone_denied', 'ja', 'en'))
    expect(alert).toHaveTextContent(getLocalizedMessage('microphone_denied', 'ja'))
    expect(alert).toHaveTextContent(getLocalizedMessage('microphone_denied', 'en'))
    // 次の録音では、もう一度 getUserMedia を呼ぶ
    const third = makeFakeStream()
    await recordOnce(1, ['b'], { stream: third })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(3)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toBe(third)
  })
})

// PR #30 のレビューの指摘（NN1 から NN6）で足した、legacykeep の守りと記録
describe('LegacyInterpreterPage with exp=legacykeep: guards and records', () => {
  it('calls getUserMedia only once when the flag is tapped twice while waiting (NN1)', async () => {
    renderLegacy(keepConfig())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    await act(async () => { await gum.calls[0].resolve(makeFakeStream()) })
    expect(recorders.instances).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    await act(async () => {
      recorders.instances[0].ondataavailable?.({ data: new Blob(['ab']) })
      recorders.instances[0].onstop?.()
    })
    await act(async () => { await Promise.resolve() })
    const json = await copyJson()
    expect(json.recordings).toHaveLength(1)
    expect(json.recordings[0].keepStream.getUserMediaCalls).toBe(1)
  })

  it('can call getUserMedia again after it failed while waiting (NN1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(keepConfig())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await recordOnce(0, ['ab'], { stream: makeFakeStream() })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    const json = await copyJson()
    expect(json.recordings[0].keepStream.getUserMediaCalls).toBe(2)
  })

  it('stops the resolved tracks and does not create a MediaRecorder when the screen goes away while waiting (NN1)', async () => {
    const { unmount } = renderLegacy(keepConfig())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    unmount()
    const stream = makeFakeStream([{}, {}])
    await act(async () => { await gum.calls[0].resolve(stream) })
    stream.tracks.forEach(t => expect(t.stop).toHaveBeenCalledTimes(1))
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(contexts.Ctor).not.toHaveBeenCalled()
    expect(recognitions.Ctor).not.toHaveBeenCalled()
  })

  it('records muted and enabled but reuses a muted track (NN2)', async () => {
    renderLegacy(keepConfig())
    const stream = makeFakeStream([{ muted: true, enabled: false }])
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const json = await copyJson()
    expect(json.recordings[1].keepStream).toMatchObject({ streamReused: true, trackStates: ['live/disabled/muted'] })
  })

  it('records the AudioContext state at creation and at the first tick (NN4)', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['a'], {
      stream: makeFakeStream(),
      beforeStop: () => {
        contexts.instances[0].state = 'suspended'
        act(() => { frames.frame(16) })
        contexts.instances[0].state = 'running'
        act(() => { frames.frame(32) })
      },
    })
    const json = await copyJson()
    expect(json.recordings[0].keepStream).toMatchObject({ audioContextState: 'running', audioContextFirstTickState: 'suspended', audioContextError: null })
  })

  it('records the AudioContext error and keeps recording (NN4)', async () => {
    ;(contexts.Ctor as unknown as { mockImplementationOnce: (f: () => never) => void }).mockImplementationOnce(function () { throw new DOMException('no audio', 'NotSupportedError') })
    renderLegacy(keepConfig())
    await recordOnce(0, ['abc'], { stream: makeFakeStream() })
    expect(recorders.instances[0].start).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.translation-card__text')).toHaveTextContent('こんにちは')
    const json = await copyJson()
    expect(json.recordings[0].blobSize).toBe(3)
    expect(json.recordings[0].keepStream).toMatchObject({ audioContextState: null, audioContextFirstTickState: null, audioContextError: 'NotSupportedError' })
  })

  it('keeps twenty recordings with legacykeep (NN5)', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['x'], { stream: makeFakeStream() })
    for (let i = 1; i < 20; i++) await recordOnce(i, ['x'.repeat(i + 1)])
    let json = await copyJson()
    expect(json.recordings).toHaveLength(20)
    expect(json.recordings[0].blobSize).toBe(1)
    await recordOnce(20, ['x'.repeat(21)])
    json = await copyJson()
    expect(json.recordings).toHaveLength(20)
    expect(json.recordings.map((r: { blobSize: number }) => r.blobSize)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
  })

  it('keeps ten recordings with legacy (NN5)', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    for (let i = 0; i < 11; i++) await recordOnce(i, ['x'.repeat(i + 1)], { stream: makeFakeStream() })
    const json = await copyJson()
    expect(json.recordings.map((r: { blobSize: number }) => r.blobSize)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('records transcriptSent as true, false and null (NN5)', async () => {
    renderLegacy(keepConfig())
    // 1回目：音声認識の文字がある
    await recordOnce(0, ['a'], {
      stream: makeFakeStream(),
      beforeStop: () => { act(() => { recognitions.instances[0].onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) }) },
    })
    // 2回目：音声認識の文字がない
    await recordOnce(1, ['b'])
    // 3回目：大きすぎて Backend に送らない
    await recordOnce(2, ['x'.repeat(MAX_INTERPRET_AUDIO_BYTES + 1)])
    const json = await copyJson()
    expect(json.recordings.map((r: { keepStream: { transcriptSent: boolean | null } }) => r.keepStream.transcriptSent)).toEqual([true, false, null])
    const interpret = (globalThis.fetch as unknown as { mock: { calls: [string, { body: FormData }][] } }).mock.calls.filter(c => c[0] === '/api/interpret')
    expect(interpret).toHaveLength(2)
    expect(interpret[0][1].body.has('transcript')).toBe(true)
    expect(interpret[1][1].body.has('transcript')).toBe(false)
  })

  it('starts the MediaRecorder, the AudioContext and the recognition in the same order on the second recording (NN6)', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await recordOnce(1, ['b'])
    const contextOrder = (contexts.Ctor as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
    for (const i of [0, 1]) {
      const recorderStart = recorders.instances[i].start.mock.invocationCallOrder[0]
      const recognitionStart = recognitions.instances[i].start.mock.invocationCallOrder[0]
      expect(recorderStart).toBeLessThan(contextOrder[i])
      expect(contextOrder[i]).toBeLessThan(recognitionStart)
    }
  })
})

// legacy は今までどおり（track の状態を読まず、停止の後に track を止める）
describe('LegacyInterpreterPage with exp=legacy (unchanged by legacykeep)', () => {
  it('does not read the track readyState and stops the track after each recording', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    const streams = [makeFakeStream(), makeFakeStream()]
    const getters = streams.map(s => {
      const getter = vi.fn(() => 'live')
      Object.defineProperty(s.tracks[0], 'readyState', { get: getter, configurable: true })
      return getter
    })
    await recordOnce(0, ['a'], { stream: streams[0] })
    expect(streams[0].tracks[0].stop).toHaveBeenCalled()
    await recordOnce(1, ['b'], { stream: streams[1] })
    expect(streams[1].tracks[0].stop).toHaveBeenCalled()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    getters.forEach(g => expect(g).not.toHaveBeenCalled())
    const json = await copyJson()
    json.recordings.forEach((r: object) => expect(r).not.toHaveProperty('keepStream'))
  })

  it('calls getUserMedia twice when the flag is tapped twice while waiting (NN1)', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('does not read readyState, muted or enabled of the track (NN2)', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    const stream = makeFakeStream()
    const getters = (['readyState', 'enabled', 'muted'] as const).map(key => {
      const getter = vi.fn(() => (key === 'readyState' ? 'live' : key === 'enabled'))
      Object.defineProperty(stream.tracks[0], key, { get: getter, configurable: true })
      return getter
    })
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'], { stream: makeFakeStream() })
    getters.forEach(g => expect(g).not.toHaveBeenCalled())
  })

  it('calls getUserMedia for every recording without exp', async () => {
    renderLegacy()
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'], { stream: makeFakeStream() })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(stream.tracks[0].stop).toHaveBeenCalled()
  })
})
