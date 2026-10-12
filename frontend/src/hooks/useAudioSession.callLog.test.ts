import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAudioSession } from './useAudioSession'
import { readExperimentConfig } from '../experiments'
import type { AudioSessionCallbacks } from './useAudioSession'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// 切り分けの実験のスイッチがないとき（URL に exp がないとき）に、ブラウザの API の呼び出しの順番と回数が、
// スイッチを入れる前（origin/main の 782635e）と同じであることを確かめる。
// 期待する並びは、同じシナリオを 782635e の useAudioSession.ts で実行して記録したもの

let restoreGlobals: () => void

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
})

afterEach(() => {
  vi.restoreAllMocks()
  restoreGlobals()
})

type Logged = { name: string; fn: { mock: { invocationCallOrder: number[] } } }

// track の状態の読み取り（getter）と addEventListener を、呼び出しの記録に入れる
function instrumentStream(stream: FakeStream, label: string, logged: Logged[]) {
  stream.tracks.forEach((track, i) => {
    for (const key of ['readyState', 'enabled', 'muted'] as const) {
      const value = track[key]
      const getter = vi.fn(() => value)
      Object.defineProperty(track, key, { get: getter, configurable: true })
      logged.push({ name: `${label}.track${i}.get:${key}`, fn: getter })
    }
    const types = new Map<string, ReturnType<typeof vi.fn<() => void>>>()
    const original = track.addEventListener
    track.addEventListener = (type: string, listener: () => void) => {
      if (!types.has(type)) {
        const fn = vi.fn<() => void>()
        types.set(type, fn)
        logged.push({ name: `${label}.track${i}.addEventListener:${type}`, fn })
      }
      types.get(type)!()
      original(type, listener)
    }
    logged.push({ name: `${label}.track${i}.stop`, fn: track.stop })
  })
}

function makeCallbacks(): AudioSessionCallbacks {
  return {
    onRecordingStarted: vi.fn(),
    onStartFailed: vi.fn(),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onRecordingStopped: vi.fn(),
    onRecorderError: vi.fn(),
    isRecordingStatus: vi.fn(() => true),
  }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

// 録音の成立、音量、音声認識、利用者の停止、中断、録音の途中の失敗を一通り通し、呼び出しの並びを返す
async function runScenario(create: (callbacks: AudioSessionCallbacks) => ReturnType<typeof createAudioSession>) {
  const gum = setupDeferredGetUserMedia()
  const recorders = setupMediaRecorder()
  const recognitions = setupSpeechRecognition()
  const contexts = setupAudioContext()
  const frames = setupAnimationFrame()
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
  const perfSpy = vi.spyOn(performance, 'now')
  const logged: Logged[] = [
    { name: 'getUserMedia', fn: gum.getUserMedia },
    { name: 'MediaRecorder.isTypeSupported', fn: vi.mocked(recorders.Ctor.isTypeSupported) },
    { name: 'new MediaRecorder', fn: recorders.Ctor as unknown as Logged['fn'] },
    { name: 'new SpeechRecognition', fn: recognitions.Ctor },
    { name: 'new AudioContext', fn: contexts.Ctor },
    { name: 'requestAnimationFrame', fn: frames.request },
    { name: 'cancelAnimationFrame', fn: frames.cancel },
    { name: 'setTimeout', fn: setTimeoutSpy },
    { name: 'clearTimeout', fn: clearTimeoutSpy },
    { name: 'performance.now', fn: perfSpy },
  ]
  const session = create(makeCallbacks())

  // セッション1：利用者の停止
  const stream1 = makeFakeStream()
  instrumentStream(stream1, 's1', logged)
  const started1 = session.start('ja-JP')
  await gum.calls[0].resolve(stream1)
  await started1
  frames.frame(16)
  frames.frame(32)
  const recognition1 = recognitions.instances[0]
  recognition1.onresult?.({ results: [[{ transcript: 'abc' }]] })
  recognition1.onerror?.({ error: 'no-speech' })
  recognition1.onend?.()
  const recorder1 = recorders.instances[0]
  recorder1.ondataavailable?.({ data: new Blob(['ab']) })
  session.stop()
  recognition1.onend?.()
  recorder1.ondataavailable?.({ data: new Blob(['cde']) })
  recorder1.onstop?.()
  await flush()

  // セッション2：中断（hidden）
  const stream2 = makeFakeStream()
  instrumentStream(stream2, 's2', logged)
  const started2 = session.start('en-US')
  await gum.calls[1].resolve(stream2)
  await started2
  frames.frame(48)
  await session.abort('hidden')
  recorders.instances[1].onstop?.()
  await flush()

  // セッション3：録音の途中の MediaRecorder の onerror
  const stream3 = makeFakeStream()
  instrumentStream(stream3, 's3', logged)
  const started3 = session.start('ja-JP')
  await gum.calls[2].resolve(stream3)
  await started3
  recorders.instances[2].onerror?.({ error: new DOMException('x', 'UnknownError') })
  await flush()

  recorders.instances.forEach((r, i) => {
    logged.push({ name: `recorder${i}.start`, fn: r.start }, { name: `recorder${i}.stop`, fn: r.stop })
  })
  recognitions.instances.forEach((r, i) => {
    logged.push({ name: `recognition${i}.start`, fn: r.start }, { name: `recognition${i}.stop`, fn: r.stop })
  })
  contexts.instances.forEach((c, i) => {
    logged.push(
      { name: `audioContext${i}.createMediaStreamSource`, fn: c.createMediaStreamSource },
      { name: `audioContext${i}.createAnalyser`, fn: c.createAnalyser },
      { name: `audioContext${i}.source.connect`, fn: c.source.connect },
      { name: `audioContext${i}.source.disconnect`, fn: c.source.disconnect },
      { name: `audioContext${i}.analyser.getByteTimeDomainData`, fn: c.analyser.getByteTimeDomainData },
      { name: `audioContext${i}.close`, fn: c.close },
    )
  })

  const calls = logged
    .flatMap(({ name, fn }) => fn.mock.invocationCallOrder.map(order => ({ name, order })))
    .sort((a, b) => a.order - b.order)
    .map(c => c.name)
  // 付けた handler（on〜 の property）の一覧
  const handlers = [
    ...recorders.instances.map((r, i) => `recorder${i}:` + Object.keys(r).filter(k => k.startsWith('on') && (r as unknown as Record<string, unknown>)[k]).sort().join(',')),
    ...recognitions.instances.map((r, i) => `recognition${i}:` + Object.keys(r).filter(k => k.startsWith('on') && (r as unknown as Record<string, unknown>)[k]).sort().join(',')),
  ]
  return { calls, handlers, diagnostics: session.getDiagnostics() }
}

// 782635e（スイッチを入れる前）の useAudioSession.ts で同じシナリオを実行して記録した並び
const EXPECTED_CALLS = [
  'getUserMedia',
  's1.track0.get:readyState', 's1.track0.get:enabled', 's1.track0.get:muted', 's1.track0.get:readyState',
  'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported',
  'new MediaRecorder', 'recorder0.start', 's1.track0.addEventListener:ended',
  'new AudioContext', 'audioContext0.createMediaStreamSource', 'audioContext0.createAnalyser', 'audioContext0.source.connect',
  'requestAnimationFrame',
  'new SpeechRecognition', 'recognition0.start',
  'audioContext0.analyser.getByteTimeDomainData', 'requestAnimationFrame',
  'audioContext0.analyser.getByteTimeDomainData', 'requestAnimationFrame',
  'recognition0.start',
  'recognition0.stop', 'cancelAnimationFrame', 'audioContext0.source.disconnect', 'audioContext0.close', 'recorder0.stop', 'setTimeout',
  'clearTimeout', 's1.track0.stop',
  'getUserMedia',
  's2.track0.get:readyState', 's2.track0.get:enabled', 's2.track0.get:muted', 's2.track0.get:readyState',
  'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported',
  'new MediaRecorder', 'recorder1.start', 's2.track0.addEventListener:ended',
  'new AudioContext', 'audioContext1.createMediaStreamSource', 'audioContext1.createAnalyser', 'audioContext1.source.connect',
  'requestAnimationFrame',
  'new SpeechRecognition', 'recognition1.start',
  'audioContext1.analyser.getByteTimeDomainData', 'requestAnimationFrame',
  'recognition1.stop', 'cancelAnimationFrame', 'audioContext1.source.disconnect', 'audioContext1.close', 'recorder1.stop', 's2.track0.stop',
  'getUserMedia',
  's3.track0.get:readyState', 's3.track0.get:enabled', 's3.track0.get:muted', 's3.track0.get:readyState',
  'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported', 'MediaRecorder.isTypeSupported',
  'new MediaRecorder', 'recorder2.start', 's3.track0.addEventListener:ended',
  'new AudioContext', 'audioContext2.createMediaStreamSource', 'audioContext2.createAnalyser', 'audioContext2.source.connect',
  'requestAnimationFrame',
  'new SpeechRecognition', 'recognition2.start',
  'recognition2.stop', 'cancelAnimationFrame', 'audioContext2.source.disconnect', 'audioContext2.close', 'recorder2.stop', 's3.track0.stop',
]

const EXPECTED_HANDLERS = [
  'recorder0:ondataavailable,onerror,onstop',
  'recorder1:ondataavailable,onerror,onstop',
  'recorder2:ondataavailable,onerror,onstop',
  'recognition0:onend,onerror,onresult',
  'recognition1:onend,onerror,onresult',
  'recognition2:onend,onerror,onresult',
]

describe('useAudioSession without experiment switches', () => {
  it('calls the browser APIs in the same order and number as before the switches', async () => {
    const { calls, handlers, diagnostics } = await runScenario(callbacks => createAudioSession(callbacks))
    expect(calls).toEqual(EXPECTED_CALLS)
    expect(handlers).toEqual(EXPECTED_HANDLERS)
    // 実験の記録（performance.now() を使う記録）をしない
    expect(calls).not.toContain('performance.now')
    expect(diagnostics.experiment).toBeUndefined()
    expect('experiment' in diagnostics).toBe(false)
  })

  it('keeps the same calls with the passive diagnostics of an empty exp (only performance.now is added)', async () => {
    const config = readExperimentConfig('?exp=')
    const { calls, handlers, diagnostics } = await runScenario(callbacks => createAudioSession(callbacks, config))
    expect(calls.filter(c => c !== 'performance.now')).toEqual(EXPECTED_CALLS)
    expect(handlers).toEqual(EXPECTED_HANDLERS)
    expect(calls).toContain('performance.now')
    expect(diagnostics.experiment?.sessions).toHaveLength(3)
  })
})
