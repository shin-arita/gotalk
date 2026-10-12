import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RECOGNITION_END_DELAY_MS, RECOGNITION_END_TIMEOUT_MS, RECORDER_STOP_TIMEOUT_MS, createAudioSession } from './useAudioSession'
import type { AudioSessionCallbacks } from './useAudioSession'
import { DEFAULT_EXPERIMENT_CONFIG, readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// 2回目の切り分けの実験のスイッチ（recogfirst、recogabort、recogdelay、recogearly、recogonce）の動き（docs/testing.md）

let restoreGlobals: () => void

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  restoreGlobals()
})

function makeCallbacks(overrides: Partial<AudioSessionCallbacks> = {}) {
  return {
    onRecordingStarted: vi.fn(),
    onStartFailed: vi.fn(),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onRecordingStopped: vi.fn(),
    onRecorderError: vi.fn(),
    isRecordingStatus: vi.fn(() => true),
    ...overrides,
  }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const handlerKeys = (obj: object) => Object.keys(obj).filter(k => k.startsWith('on') && (obj as Record<string, unknown>)[k]).sort()

function countListeners(stream: FakeStream) {
  const counts = new Map<string, number>()
  stream.tracks.forEach(track => {
    const original = track.addEventListener
    track.addEventListener = (type: string, listener: () => void) => {
      counts.set(type, (counts.get(type) ?? 0) + 1)
      original(type, listener)
    }
  })
  return counts
}

function setup(config: ExperimentConfig, options: { recorder?: Parameters<typeof setupMediaRecorder>[0] } = {}) {
  const gum = setupDeferredGetUserMedia()
  const recorders = setupMediaRecorder(options.recorder)
  const recognitions = setupSpeechRecognition()
  const contexts = setupAudioContext()
  const frames = setupAnimationFrame()
  const callbacks = makeCallbacks()
  const session = createAudioSession(callbacks, config)
  return { gum, recorders, recognitions, contexts, frames, callbacks, session }
}

// n 回目の録音を始めて、録音を成立させる
async function record(env: ReturnType<typeof setup>, n: number, stream: FakeStream = makeFakeStream()) {
  const started = env.session.start('ja-JP')
  await env.gum.calls[n].resolve(stream)
  await started
  return stream
}

async function startWith(exp: string, options: Parameters<typeof setup>[1] = {}) {
  const env = setup(readExperimentConfig(exp), options)
  const stream = makeFakeStream()
  const listeners = countListeners(stream)
  await record(env, 0, stream)
  return { ...env, stream, listeners }
}

const trace = (session: ReturnType<typeof createAudioSession>, index = 0) => session.getDiagnostics().experiment!.sessions[index]

describe('without the switches', () => {
  it('does not wait for the recognition end, nor create a timer for it, nor call abort()', async () => {
    vi.useFakeTimers()
    const { session, recorders, recognitions } = await startWith('?exp=')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    session.stop()
    // 今と同じく、音声認識の stop() の直後に MediaRecorder の stop() を呼ぶ
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls.map(c => c[1])).toEqual([RECORDER_STOP_TIMEOUT_MS])
    await session.abort('hidden')
    expect(recognitions.instances[0].abort).not.toHaveBeenCalled()
    const t = trace(session)
    expect(t.recognitionEndWait).toBeNull()
    expect(t.recogEarly).toBeNull()
    expect(session.getDiagnostics().experiment!.recognitionOnce).toBeNull()
  })

  it('creates a new recognition for each recording and starts it after the recording', async () => {
    const env = setup(DEFAULT_EXPERIMENT_CONFIG)
    await record(env, 0)
    expect(env.gum.getUserMedia.mock.invocationCallOrder[0]).toBeLessThan(env.recognitions.instances[0].start.mock.invocationCallOrder[0])
    env.session.stop()
    env.recorders.instances[0].onstop?.()
    await record(env, 1)
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(2)
  })
})

describe('experiment: recogfirst', () => {
  it('calls MediaRecorder stop() once, only after the recognition end', async () => {
    const { session, callbacks, recorders, recognitions, contexts } = await startWith('?exp=recogfirst')
    const recognition = recognitions.instances[0]
    session.stop()
    expect(recognition.stop).toHaveBeenCalledTimes(1)
    // 音量の取得の片付けは、今と同じく MediaRecorder の stop() の前（end を待つ前）に始める
    expect(contexts.instances[0].source.disconnect).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    await flush()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    recognition.onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognition.stop.mock.invocationCallOrder[0]).toBeLessThan(recorders.instances[0].stop.mock.invocationCallOrder[0])
    // 音声認識は始め直さない
    expect(recognition.start).toHaveBeenCalledTimes(1)
    recognition.onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    recorders.instances[0].ondataavailable?.({ data: new Blob(['abc']) })
    recorders.instances[0].onstop?.()
    expect(vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0].size).toBe(3)
    const wait = trace(session).recognitionEndWait!
    expect(wait.waitStartedAt).toEqual(expect.any(Number))
    expect(wait.endAt).toEqual(expect.any(Number))
    expect(wait.recognitionEndTimedOut).toBe(false)
    expect(wait.lateEndAt).toBeNull()
    expect(trace(session).recorder.stopCalls[0].at).toBeGreaterThanOrEqual(wait.endAt!)
  })

  it('does not settle the wait with an error (aborted) alone', async () => {
    const { session, recorders, recognitions } = await startWith('?exp=recogfirst')
    session.stop()
    recognitions.instances[0].onerror?.({ error: 'aborted' })
    await flush()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    expect(trace(session).recognition.events.map(e => e.type)).toContain('error')
    recognitions.instances[0].onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('gives up after 1.5 s, calls MediaRecorder stop(), and the later end does nothing', async () => {
    vi.useFakeTimers()
    const { session, recorders, recognitions } = await startWith('?exp=recogfirst')
    session.stop()
    vi.advanceTimersByTime(RECOGNITION_END_TIMEOUT_MS - 1)
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    recognitions.instances[0].onend?.()
    recognitions.instances[0].onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    const diagnostics = session.getDiagnostics()
    const wait = diagnostics.experiment!.sessions[0].recognitionEndWait!
    expect(wait.recognitionEndTimedOut).toBe(true)
    expect(wait.timedOutAt).toEqual(expect.any(Number))
    expect(wait.endAt).toBeNull()
    expect(wait.lateEndAt).toEqual(expect.any(Number))
    expect(diagnostics.events.map(e => e.type)).toContain('recognition_end_timeout')
    // 見張りのタイマーの見切りとは別の項目
    expect(diagnostics.sessions[0].recorder.stopTimedOut).toBe(false)
  })

  it('settles the wait before the restart check (the end after s.recognition is cleared)', async () => {
    const { session, recorders, recognitions } = await startWith('?exp=recogfirst')
    session.stop()
    // stopRecognition が s.recognition を空にした後に届く end。今の「始め直してよいか」の判定はここで早く戻る
    const events = trace(session).recognition.events.map(e => e.type)
    expect(events).toEqual(['start_call', 'stop_call'])
    recognitions.instances[0].onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('does not settle the wait with the end of another session', async () => {
    const env = setup(readExperimentConfig('?exp=recogfirst'))
    await record(env, 0)
    const first = env.recognitions.instances[0]
    env.session.stop()
    first.onend?.()
    env.recorders.instances[0].onstop?.()
    await record(env, 1)
    const second = env.recognitions.instances[1]
    env.session.stop()
    // 前のセッションの部品の end（遅れて届いたもの）では解けない
    first.onend?.()
    await flush()
    expect(env.recorders.instances[1].stop).not.toHaveBeenCalled()
    second.onend?.()
    expect(env.recorders.instances[1].stop).toHaveBeenCalledTimes(1)
  })

  it('cancels the timers and leaves MediaRecorder stop() to the abort cleanup when aborted while waiting', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders, recognitions } = await startWith('?exp=recogfirst')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    session.stop()
    await session.abort('hidden')
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    // 見張りのタイマーと、1.5 秒のタイマーを取り消す
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2)
    recognitions.instances[0].onend?.()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    const t = trace(session)
    expect(t.recorder.stopCalls.map(c => c.by)).toEqual(['cleanup'])
    expect(t.recognitionEndWait!.cancelledAt).toEqual(expect.any(Number))
    expect(t.recognitionEndWait!.endAt).toBeNull()
  })

  it('starts only one watchdog, before waiting', async () => {
    vi.useFakeTimers()
    const { session, recognitions } = await startWith('?exp=recogfirst')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    session.stop()
    expect(setTimeoutSpy.mock.calls.map(c => c[1])).toEqual([RECORDER_STOP_TIMEOUT_MS, RECOGNITION_END_TIMEOUT_MS])
    recognitions.instances[0].onend?.()
    expect(setTimeoutSpy.mock.calls.filter(c => c[1] === RECORDER_STOP_TIMEOUT_MS)).toHaveLength(1)
  })

  it('fails the recording by the watchdog when onstop never comes after the end', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recognitions } = await startWith('?exp=recogfirst')
    session.stop()
    recognitions.instances[0].onend?.()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().sessions[0].recorder.stopTimedOut).toBe(true)
    expect(trace(session).recognitionEndWait!.recognitionEndTimedOut).toBe(false)
  })

  it('does not wait when there is no recognition', async () => {
    const env = setup(readExperimentConfig('?exp=recogfirst'))
    env.recognitions.Ctor.mockImplementation(() => { throw new Error('unavailable') })
    await record(env, 0)
    env.session.stop()
    expect(env.recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(trace(env.session).recognitionEndWait!.noRecognition).toBe(true)
    expect(trace(env.session).recognitionEndWait!.waitStartedAt).toBeNull()
  })

  it('waits for the end and then for close() with awaitclose', async () => {
    const { session, recorders, recognitions, contexts } = await startWith('?exp=recogfirst,awaitclose')
    const ctx = contexts.instances[0]
    let finishClose!: () => void
    ctx.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = () => { ctx.state = 'closed'; resolve() } }))
    session.stop()
    recognitions.instances[0].onend?.()
    await flush()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    finishClose()
    await flush()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('does not call MediaRecorder stop() when aborted after the end while waiting for close() with awaitclose', async () => {
    const { session, recognitions, contexts } = await startWith('?exp=recogfirst,awaitclose')
    const ctx = contexts.instances[0]
    let finishClose!: () => void
    ctx.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = () => { ctx.state = 'closed'; resolve() } }))
    session.stop()
    recognitions.instances[0].onend?.()
    const aborted = session.abort('hidden')
    finishClose()
    await aborted
    await flush()
    expect(trace(session).recorder.stopCalls.map(c => c.by)).toEqual(['cleanup'])
  })

  it('restarts the recognition on the end while recording, as now', async () => {
    const { recorders, recognitions } = await startWith('?exp=recogfirst')
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(2)
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
  })

  it('aborts without the user stop as now', async () => {
    const { session, recorders, recognitions } = await startWith('?exp=recogfirst')
    await session.abort('hidden')
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(trace(session).recognitionEndWait!.cancelledAt).toBeNull()
  })

  it('does not cancel a finished wait when the cleanup runs after onstop', async () => {
    const { session, callbacks, recorders, recognitions } = await startWith('?exp=recogfirst')
    session.stop()
    recognitions.instances[0].onend?.()
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(trace(session).recognitionEndWait!.cancelledAt).toBeNull()
  })

  it('waits for close() after the end even when close() finished first', async () => {
    const { session, recorders, recognitions } = await startWith('?exp=recogfirst,awaitclose')
    session.stop()
    await flush()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    recognitions.instances[0].onend?.()
    await flush()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })
})

describe('experiment: recogabort', () => {
  it('calls abort() instead of stop() on the user stop', async () => {
    const { session, recognitions, recorders } = await startWith('?exp=recogabort')
    session.stop()
    expect(recognitions.instances[0].abort).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).not.toHaveBeenCalled()
    // recogfirst がないので、待たずに MediaRecorder の stop() を呼ぶ
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    recorders.instances[0].onstop?.()
    expect(recognitions.instances[0].stop).not.toHaveBeenCalled()
    expect(trace(session).recognition.events.map(e => e.type)).toEqual(['start_call', 'abort_call'])
  })

  it('calls abort() instead of stop() on abort', async () => {
    const { session, recognitions } = await startWith('?exp=recogabort')
    await session.abort('hidden')
    expect(recognitions.instances[0].abort).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).not.toHaveBeenCalled()
  })

  it('calls abort(), then waits for the end, then MediaRecorder stop() with recogfirst', async () => {
    const { session, recognitions, recorders } = await startWith('?exp=recogfirst,recogabort')
    const recognition = recognitions.instances[0]
    session.stop()
    expect(recognition.abort).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    recognition.onerror?.({ error: 'aborted' })
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    recognition.onend?.()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognition.abort.mock.invocationCallOrder[0]).toBeLessThan(recorders.instances[0].stop.mock.invocationCallOrder[0])
    expect(recognition.stop).not.toHaveBeenCalled()
  })
})

describe('experiment: recogdelay', () => {
  it('calls MediaRecorder stop() 500 ms after the end with recogfirst', async () => {
    vi.useFakeTimers()
    const { session, recognitions, recorders } = await startWith('?exp=recogfirst,recogdelay')
    session.stop()
    recognitions.instances[0].onend?.()
    vi.advanceTimersByTime(RECOGNITION_END_DELAY_MS - 1)
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    const wait = trace(session).recognitionEndWait!
    expect(wait.delayEndedAt).toEqual(expect.any(Number))
    expect(wait.delayEndedAt!).toBeGreaterThanOrEqual(wait.endAt!)
    // 1.5 秒の見切りは、end で取り消している
    vi.advanceTimersByTime(RECOGNITION_END_TIMEOUT_MS)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(wait.recognitionEndTimedOut).toBe(false)
  })

  it('does not call MediaRecorder stop() when aborted during the 500 ms', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recognitions, recorders } = await startWith('?exp=recogfirst,recogdelay')
    session.stop()
    recognitions.instances[0].onend?.()
    vi.advanceTimersByTime(RECOGNITION_END_DELAY_MS / 2)
    await session.abort('hidden')
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    const t = trace(session)
    expect(t.recorder.stopCalls.map(c => c.by)).toEqual(['cleanup'])
    expect(t.recognitionEndWait!.delayEndedAt).toBeNull()
    expect(t.recognitionEndWait!.cancelledAt).toEqual(expect.any(Number))
  })

  it('does nothing without recogfirst (inactive)', async () => {
    vi.useFakeTimers()
    const { session, recorders } = await startWith('?exp=recogdelay')
    session.stop()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })
})

describe('experiment: recogearly', () => {
  it('starts the recognition before getUserMedia and not again after the recording starts', async () => {
    const env = setup(readExperimentConfig('?exp=recogearly'))
    const started = env.session.start('ja-JP')
    const recognition = env.recognitions.instances[0]
    expect(recognition.start).toHaveBeenCalledTimes(1)
    expect(recognition.start.mock.invocationCallOrder[0]).toBeLessThan(env.gum.getUserMedia.mock.invocationCallOrder[0])
    await env.gum.calls[0].resolve()
    await started
    expect(env.recorders.instances[0].start).toHaveBeenCalledTimes(1)
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(1)
    expect(recognition.start).toHaveBeenCalledTimes(1)
    const t = trace(env.session)
    expect(t.recognition.events[0].at).toBeLessThanOrEqual(t.getUserMediaCalledAt!)
    // 利用者の停止は今と同じ
    env.session.stop()
    expect(recognition.stop).toHaveBeenCalledTimes(1)
    expect(env.recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(t.recogEarly).toEqual({ stoppedBeforeRecordingAt: null })
  })

  async function failStart(exp: string, fail: (env: ReturnType<typeof setup>, started: Promise<void>) => Promise<void>, options: Parameters<typeof setup>[1] = {}) {
    const env = setup(readExperimentConfig(exp), options)
    const started = env.session.start('ja-JP')
    await fail(env, started)
    await started
    await flush()
    return { ...env, recognition: env.recognitions.instances[0] }
  }

  it.each([
    ['getUserMedia fails', async (env: ReturnType<typeof setup>) => { await env.gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) }, {}],
    ['aborted while waiting for getUserMedia', async (env: ReturnType<typeof setup>) => { await env.session.abort('hidden'); await env.gum.calls[0].resolve() }, {}],
    ['there is no track', async (env: ReturnType<typeof setup>) => { await env.gum.calls[0].resolve(makeFakeStream([])) }, {}],
    ['the track is not live', async (env: ReturnType<typeof setup>) => { await env.gum.calls[0].resolve(makeFakeStream([{ readyState: 'ended' }])) }, {}],
    ['new MediaRecorder throws', async (env: ReturnType<typeof setup>) => { await env.gum.calls[0].resolve() }, { recorder: { throwOnCreate: true } }],
    ['MediaRecorder start() throws', async (env: ReturnType<typeof setup>) => { await env.gum.calls[0].resolve() }, { recorder: { throwOnStart: true } }],
  ] as const)('stops the early recognition when %s', async (_, fail, options) => {
    const { session, recognition, callbacks } = await failStart('?exp=recogearly', fail, options)
    expect(recognition.stop).toHaveBeenCalledTimes(1)
    expect(recognition.abort).not.toHaveBeenCalled()
    expect(callbacks.onRecordingStarted).not.toHaveBeenCalled()
    expect(trace(session).recogEarly!.stoppedBeforeRecordingAt).toEqual(expect.any(Number))
  })

  it('stops the early recognition with abort() with recogabort', async () => {
    const { recognition } = await failStart('?exp=recogearly,recogabort', async env => { await env.gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(recognition.abort).toHaveBeenCalledTimes(1)
    expect(recognition.stop).not.toHaveBeenCalled()
  })

  it('stops the early recognition when a not-live track is accepted by notrackread but the recorder fails', async () => {
    const { recognition, callbacks } = await failStart('?exp=recogearly,notrackread', async env => { await env.gum.calls[0].resolve(makeFakeStream([{ readyState: 'ended' }])) }, { recorder: { throwOnStart: true } })
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('recording_start_failed', 'InvalidStateError')
    expect(recognition.stop).toHaveBeenCalledTimes(1)
  })
})

describe('experiment: recogonce', () => {
  async function twoRecordings(exp: string) {
    const env = setup(readExperimentConfig(exp))
    await record(env, 0)
    env.session.stop()
    env.recorders.instances[0].onstop?.()
    await flush()
    return env
  }

  it('creates the recognition once and starts the same one for the second recording', async () => {
    const env = await twoRecordings('?exp=recogonce')
    const recognition = env.recognitions.instances[0]
    expect(recognition.stop).toHaveBeenCalledTimes(1)
    await record(env, 1)
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(1)
    expect(recognition.start).toHaveBeenCalledTimes(2)
    recognition.onresult?.({ results: [[{ transcript: 'abc' }]] })
    expect(env.callbacks.onTranscript).toHaveBeenCalledWith('abc')
    env.session.stop()
    expect(recognition.stop).toHaveBeenCalledTimes(2)
    const once = env.session.getDiagnostics().experiment!.recognitionOnce!
    expect(once.createdCount).toBe(1)
    expect(once.events.map(e => [e.type, e.boundSessionId, e.activeSessionId])).toEqual([['start_call', 1, 1], ['start_call', 2, 2], ['result', 2, 2]])
  })

  it('does not let the events of the old session act on the new session', async () => {
    const env = await twoRecordings('?exp=recogonce')
    const recognition = env.recognitions.instances[0]
    // 2回目の getUserMedia を待っている間（音声認識を2回目に start() する前）に、1回目の出来事が届く
    const started = env.session.start('ja-JP')
    recognition.onresult?.({ results: [[{ transcript: 'old' }]] })
    recognition.onerror?.({ error: 'aborted' })
    recognition.onend?.()
    expect(env.callbacks.onTranscript).not.toHaveBeenCalled()
    expect(recognition.start).toHaveBeenCalledTimes(1)
    expect(env.session.getDiagnostics().events.map(e => e.type)).not.toContain('recognition_error:aborted')
    const once = env.session.getDiagnostics().experiment!.recognitionOnce!
    expect(once.events.slice(-3).map(e => [e.type, e.boundSessionId, e.activeSessionId])).toEqual([['result', 1, 2], ['error', 1, 2], ['end', 1, 2]])
    await env.gum.calls[1].resolve()
    await started
    expect(recognition.start).toHaveBeenCalledTimes(2)
  })

  it('does not settle the recogfirst wait of the new session with the end bound to the old session', async () => {
    const env = setup(readExperimentConfig('?exp=recogonce,recogfirst'))
    await record(env, 0)
    const recognition = env.recognitions.instances[0]
    const oldOnEnd = recognition.onend!
    env.session.stop()
    oldOnEnd()
    env.recorders.instances[0].onstop?.()
    await record(env, 1)
    env.session.stop()
    // 1回目のセッションに結び付けた handler に届いた end
    oldOnEnd()
    await flush()
    expect(env.recorders.instances[1].stop).not.toHaveBeenCalled()
    recognition.onend?.()
    expect(env.recorders.instances[1].stop).toHaveBeenCalledTimes(1)
  })

  it('stops the recognition on unmount while recording, once', async () => {
    const env = setup(readExperimentConfig('?exp=recogonce'))
    await record(env, 0)
    await env.session.abort('unmount')
    await env.session.abort('unmount')
    expect(env.recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(env.session.getDiagnostics().experiment!.recognitionOnce!.disposedAt).toEqual(expect.any(Number))
  })

  it('stops the restarted recognition on unmount with abort() (recogabort), once, and releases it', async () => {
    const env = setup(readExperimentConfig('?exp=recogonce,recogabort'))
    await record(env, 0)
    const recognition = env.recognitions.instances[0]
    // 録音の途中で始め直した後
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    await env.session.abort('unmount')
    expect(recognition.abort).toHaveBeenCalledTimes(1)
    expect(recognition.stop).not.toHaveBeenCalled()
    // 手放した後の録音では、作り直す
    await record(env, 1)
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(2)
  })

  it('does not stop the recognition on unmount after it was stopped', async () => {
    const env = await twoRecordings('?exp=recogonce')
    await env.session.abort('unmount')
    expect(env.recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('keeps the recognition on abort other than unmount', async () => {
    const env = setup(readExperimentConfig('?exp=recogonce'))
    await record(env, 0)
    await env.session.abort('hidden')
    await record(env, 1)
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(1)
    expect(env.recognitions.instances[0].start).toHaveBeenCalledTimes(2)
  })
})

describe('the new switches without trace', () => {
  it.each(['recogfirst', 'recogabort', 'recogfirst,recogdelay', 'recogearly', 'recogonce'])('adds no new listeners with %s', async (exp) => {
    const env = setup(readExperimentConfig(`?exp=${exp}`))
    const stream = makeFakeStream()
    const listeners = countListeners(stream)
    await record(env, 0, stream)
    expect(Object.fromEntries(listeners)).toEqual({ ended: 1 })
    expect(handlerKeys(env.recorders.instances[0])).toEqual(['ondataavailable', 'onerror', 'onstop'])
    expect(handlerKeys(env.recognitions.instances[0])).toEqual(['onend', 'onerror', 'onresult'])
  })
})

describe('the new switches without the diagnostics', () => {
  // URL からは作れない組み合わせ（enabled が false のままスイッチだけが true）。記録がなくても動きが変わらないこと
  const crafted = (overrides: Partial<ExperimentConfig>): ExperimentConfig => ({ ...DEFAULT_EXPERIMENT_CONFIG, ...overrides })

  it('waits for the end, aborts, and delays without recording anything', async () => {
    vi.useFakeTimers()
    const env = setup(crafted({ recogFirst: true, recogAbort: true, recogDelay: true, recogOnce: true, recogEarly: true }))
    await record(env, 0)
    const recognition = env.recognitions.instances[0]
    env.session.stop()
    expect(recognition.abort).toHaveBeenCalledTimes(1)
    recognition.onend?.()
    vi.advanceTimersByTime(RECOGNITION_END_DELAY_MS)
    expect(env.recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    env.recorders.instances[0].onstop?.()
    await record(env, 1)
    env.session.stop()
    vi.advanceTimersByTime(RECOGNITION_END_TIMEOUT_MS)
    expect(env.recorders.instances[1].stop).toHaveBeenCalledTimes(1)
    recognition.onend?.()
    await env.session.abort('unmount')
    expect(env.recognitions.Ctor).toHaveBeenCalledTimes(1)
    expect(env.session.getDiagnostics().experiment).toBeUndefined()
  })
})
