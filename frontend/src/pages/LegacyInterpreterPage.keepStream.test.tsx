import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import LegacyInterpreterPage from './LegacyInterpreterPage'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
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
    // 次の録音では、新しい stream を使い回す
    await recordOnce(2, ['c'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[2][0]).toBe(second)
    const json = await copyJson()
    expect(json.recordings.map((r: { keepStream: unknown }) => r.keepStream)).toEqual([
      expect.objectContaining({ streamReused: false, getUserMediaCalls: 1, trackReadyStates: [] }),
      expect.objectContaining({ streamReused: false, getUserMediaCalls: 2, trackReadyStates: ['ended'] }),
      expect.objectContaining({ streamReused: true, getUserMediaCalls: 2, trackReadyStates: ['live'] }),
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

  it('records streamReused, the getUserMedia count, the readyState and the RMS', async () => {
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
    expect(json.recordings[0].keepStream).toEqual({ streamReused: false, getUserMediaCalls: 1, trackReadyStates: [], rmsMax: 0.5, rmsNonZeroSamples: 1, rmsSamples: 2 })
    expect(json.recordings[1].keepStream).toEqual({ streamReused: true, getUserMediaCalls: 1, trackReadyStates: ['live'], rmsMax: 0, rmsNonZeroSamples: 0, rmsSamples: 1 })
    // legacy と同じ記録も残る
    expect(json.recordings[1].blobSize).toBe(2)
  })

  it('shows the keepStream values only when 更新 is pressed', async () => {
    renderLegacy(keepConfig())
    await recordOnce(0, ['ab'], { stream: makeFakeStream(), beforeStop: () => { act(() => { frames.frame(16) }) } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    const snapshot = screen.getByTestId('experiment-snapshot')
    expect(snapshot).toHaveTextContent('（legacykeep）')
    expect(snapshot).toHaveTextContent('マイク=getUserMedia（呼んだ回数の合計=1、readyState=-）、RMS 最大=0.500、0 でない回数=1/1')
    await recordOnce(1, ['cd'])
    // 押すまでは変わらない
    expect(snapshot).not.toHaveTextContent('使い回し')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('マイク=使い回し（呼んだ回数の合計=1、readyState=live）、RMS 最大=0.000、0 でない回数=0/0')
  })

  it('keeps the recording working when getUserMedia fails after the track has ended', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(keepConfig())
    const first = makeFakeStream()
    await recordOnce(0, ['a'], { stream: first })
    endTrack(first.tracks[0])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[1].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    // 次の録音では、もう一度 getUserMedia を呼ぶ
    const third = makeFakeStream()
    await recordOnce(1, ['b'], { stream: third })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(3)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toBe(third)
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

  it('calls getUserMedia for every recording without exp', async () => {
    renderLegacy()
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'], { stream: makeFakeStream() })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(stream.tracks[0].stop).toHaveBeenCalled()
  })
})
