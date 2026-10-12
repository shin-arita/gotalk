import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RECORDER_STOP_TIMEOUT_MS, createAudioSession } from './useAudioSession'
import type { AudioSessionCallbacks } from './useAudioSession'
import { readExperimentConfig } from '../experiments'
import {
  AUDIO_GLOBALS, endTrack, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia,
  setupMediaRecorder, setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream, FakeTrack } from '../test/audioMocks'

// 切り分けの実験のスイッチ（docs/testing.md の「実験のスイッチ」）ごとの動き

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

// track の addEventListener の type ごとの回数を数える
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

async function startWith(exp: string, options: { stream?: FakeStream; recognition?: Parameters<typeof setupSpeechRecognition>[0] } = {}) {
  const config = readExperimentConfig(exp)
  const gum = setupDeferredGetUserMedia()
  const recorders = setupMediaRecorder()
  const recognitions = setupSpeechRecognition(options.recognition)
  const contexts = setupAudioContext()
  const frames = setupAnimationFrame()
  const callbacks = makeCallbacks()
  const session = createAudioSession(callbacks, config)
  const stream = options.stream ?? makeFakeStream()
  const listeners = countListeners(stream)
  const started = session.start('ja-JP')
  await gum.calls[0].resolve(stream)
  await started
  return { config, session, callbacks, gum, recorders, recognitions, contexts, frames, stream, listeners }
}

const handlerKeys = (obj: object) => Object.keys(obj).filter(k => k.startsWith('on') && (obj as Record<string, unknown>)[k]).sort()

describe('experiment: norecog', () => {
  it('does not create the recognition and still sends the recording', async () => {
    const { session, callbacks, recorders, recognitions } = await startWith('?exp=norecog')
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    session.stop()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['abc']) })
    recorders.instances[0].onstop?.()
    expect(vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0].size).toBe(3)
    expect(session.getDiagnostics().events.map(e => e.type)).not.toContain('recognition_unavailable')
  })
})

describe('experiment: legacyrecog', () => {
  it('keeps the recognition in the session only after start() succeeds', async () => {
    const { session, recognitions } = await startWith('?exp=legacyrecog')
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
    // ref に入っているので、利用者の停止で stop() される
    session.stop()
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('leaves the recognition out of the session when start() throws', async () => {
    const config = readExperimentConfig('?exp=legacyrecog')
    const gum = setupDeferredGetUserMedia()
    setupMediaRecorder()
    const recognitions = setupSpeechRecognition()
    setupAudioContext()
    setupAnimationFrame()
    const original = recognitions.Ctor.getMockImplementation()!
    recognitions.Ctor.mockImplementation(function () {
      const r = original()
      r.start.mockImplementation(() => { throw new Error('busy') })
      return r
    })
    const session = createAudioSession(makeCallbacks(), config)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recognition_failed:Error')
    session.stop()
    // ref が空なので、stop() されない
    expect(recognitions.instances[0].stop).not.toHaveBeenCalled()
  })

  it('restarts on onend only while the MediaRecorder is recording', async () => {
    const isRecordingStatus = vi.fn(() => false)
    const config = readExperimentConfig('?exp=legacyrecog')
    const gum = setupDeferredGetUserMedia()
    const recorders = setupMediaRecorder()
    const recognitions = setupSpeechRecognition()
    setupAudioContext()
    setupAnimationFrame()
    const session = createAudioSession(makeCallbacks({ isRecordingStatus }), config)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    const recognition = recognitions.instances[0]
    // 画面の状態は見ない（PR #26 の前と同じく、MediaRecorder の state だけで決める）
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    expect(isRecordingStatus).not.toHaveBeenCalled()
    recorders.instances[0].state = 'paused'
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    recorders.instances[0].state = 'recording'
    session.stop()
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
  })

  it('does not restart while awaitclose waits for close(), although the MediaRecorder is still recording', async () => {
    const { session, recorders, recognitions, contexts } = await startWithDeferredClose('?exp=legacyrecog,awaitclose')
    session.stop()
    expect(recorders.instances[0].state).toBe('recording')
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
    contexts.finishClose()
    await flush()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })
})

describe('experiment: nometer', () => {
  it('does not use the AudioContext nor requestAnimationFrame, and the user stop still sends the blob', async () => {
    const { session, callbacks, recorders, contexts, frames } = await startWith('?exp=nometer')
    expect(contexts.Ctor).not.toHaveBeenCalled()
    expect(frames.request).not.toHaveBeenCalled()
    session.stop()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    recorders.instances[0].ondataavailable?.({ data: new Blob(['abcd']) })
    recorders.instances[0].onstop?.()
    expect(vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0].size).toBe(4)
    expect(frames.cancel).not.toHaveBeenCalled()
  })
})

describe('experiment: nodisconnect', () => {
  it('closes without disconnect() on the user stop', async () => {
    const { session, contexts } = await startWith('?exp=nodisconnect')
    session.stop()
    expect(contexts.instances[0].source.disconnect).not.toHaveBeenCalled()
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().experiment?.sessions[0].audioContext.disconnectSkipped).toBe(true)
  })

  it('closes without disconnect() on abort', async () => {
    const { session, contexts } = await startWith('?exp=nodisconnect')
    await session.abort('hidden')
    expect(contexts.instances[0].source.disconnect).not.toHaveBeenCalled()
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
  })
})

// close() を、テストが終わらせるまで終わらない Promise にする
async function startWithDeferredClose(exp: string) {
  const result = await startWith(exp)
  const ctx = result.contexts.instances[0]
  let finish!: () => void
  ctx.close.mockImplementation(() => new Promise<void>(resolve => { finish = () => { ctx.state = 'closed'; resolve() } }))
  return { ...result, contexts: { ...result.contexts, finishClose: () => finish() } }
}

describe('experiment: awaitclose', () => {
  it('calls MediaRecorder stop() only after close() finishes', async () => {
    const { session, callbacks, recorders, contexts } = await startWithDeferredClose('?exp=awaitclose')
    session.stop()
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    await flush()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    contexts.finishClose()
    await flush()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    recorders.instances[0].ondataavailable?.({ data: new Blob(['ab']) })
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    const trace = session.getDiagnostics().experiment!.sessions[0]
    expect(trace.audioContext.closeResolvedAt).not.toBeNull()
    expect(trace.recorder.stopCalls).toEqual([{ at: expect.any(Number), by: 'user' }])
    expect(trace.recorder.stopCalls[0].at).toBeGreaterThanOrEqual(trace.audioContext.closeResolvedAt!)
  })

  it('leaves the MediaRecorder stop() to the abort cleanup when aborted while waiting', async () => {
    const { session, callbacks, recorders, contexts } = await startWithDeferredClose('?exp=awaitclose')
    session.stop()
    const aborted = session.abort('hidden')
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    contexts.finishClose()
    await aborted
    await flush()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(session.getDiagnostics().experiment!.sessions[0].recorder.stopCalls.map(c => c.by)).toEqual(['cleanup'])
  })

  it('fails the recording by the watchdog when close() never finishes', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders, stream } = await startWithDeferredClose('?exp=awaitclose')
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recorder_stop_timeout')
  })

  it('does not start a second watchdog after close() finishes', async () => {
    vi.useFakeTimers()
    const { session, contexts } = await startWithDeferredClose('?exp=awaitclose')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    session.stop()
    contexts.finishClose()
    await flush()
    expect(setTimeoutSpy.mock.calls.filter(c => c[1] === RECORDER_STOP_TIMEOUT_MS)).toHaveLength(1)
  })
})

describe('experiment: notrackread', () => {
  function stateGetters(stream: FakeStream) {
    return stream.tracks.flatMap(track => (['readyState', 'enabled', 'muted'] as const).map(key => {
      const value = track[key]
      const getter = vi.fn(() => value)
      Object.defineProperty(track, key, { get: getter, configurable: true })
      return getter
    }))
  }

  it('does not read readyState, enabled, muted and starts with a track that is not live', async () => {
    const stream = makeFakeStream([{ readyState: 'ended' }])
    const getters = stateGetters(stream)
    const { session, callbacks } = await startWith('?exp=notrackread', { stream })
    getters.forEach(g => expect(g).not.toHaveBeenCalled())
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(callbacks.onStartFailed).not.toHaveBeenCalled()
    const diagnostics = session.getDiagnostics()
    expect(diagnostics.sessions[0].tracks).toEqual([])
    expect(diagnostics.experiment!.sessions[0].tracksRead).toBe(false)
  })

  it('still fails when there is no audio track', async () => {
    const { callbacks } = await startWith('?exp=notrackread', { stream: makeFakeStream([]) })
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('recording_start_failed', 'NoAudioTrackError')
  })
})

describe('experiment: noendedlistener', () => {
  it('does not add the ended listener', async () => {
    const { listeners } = await startWith('?exp=noendedlistener')
    expect(listeners.get('ended')).toBeUndefined()
    expect([...listeners.keys()]).toEqual([])
  })
})

describe('experiment: trace', () => {
  it('adds new listeners only for the events the current version does not have', async () => {
    const { listeners, recorders, recognitions } = await startWith('?exp=trace')
    expect(Object.fromEntries(listeners)).toEqual({ ended: 1, mute: 1, unmute: 1 })
    expect(handlerKeys(recorders.instances[0])).toEqual(['ondataavailable', 'onerror', 'onstart', 'onstop'])
    expect(handlerKeys(recognitions.instances[0])).toEqual(['onaudioend', 'onaudiostart', 'onend', 'onerror', 'onresult', 'onstart'])
  })

  it('does not add the new listeners without trace', async () => {
    const { listeners, recorders, recognitions } = await startWith('?exp=')
    expect(Object.fromEntries(listeners)).toEqual({ ended: 1 })
    expect(handlerKeys(recorders.instances[0])).toEqual(['ondataavailable', 'onerror', 'onstop'])
    expect(handlerKeys(recognitions.instances[0])).toEqual(['onend', 'onerror', 'onresult'])
  })

  it('records the track, MediaRecorder and recognition events', async () => {
    const { session, recorders, recognitions, stream } = await startWith('?exp=trace')
    ;(recorders.instances[0] as unknown as { onstart: () => void }).onstart()
    const r = recognitions.instances[0] as unknown as Record<string, () => void>
    r.onstart()
    r.onaudiostart()
    r.onaudioend()
    const track = stream.tracks[0] as FakeTrack & { listeners: Map<string, Set<() => void>> }
    track.listeners.get('mute')!.forEach(l => l())
    track.listeners.get('unmute')!.forEach(l => l())
    endTrack(stream.tracks[0])
    const trace = session.getDiagnostics().experiment!.sessions[0]
    expect(trace.recorder.onstartAt).not.toBeNull()
    expect(trace.recognition.events.map(e => e.type)).toEqual(['start_call', 'start', 'audiostart', 'audioend'])
    expect(trace.trackEvents.map(e => e.type)).toEqual(['mute', 'unmute', 'ended'])
  })

  it('does not add the ended listener with noendedlistener and says ended is not recorded', async () => {
    const { session, listeners } = await startWith('?exp=trace,noendedlistener')
    expect(Object.fromEntries(listeners)).toEqual({ mute: 1, unmute: 1 })
    expect(session.getDiagnostics().experiment!.endedNotRecorded).toBe('noendedlistener のため ended は記録しない')
  })

  it('does not record ended without trace (passive)', async () => {
    const { session, stream } = await startWith('?exp=')
    endTrack(stream.tracks[0])
    expect(session.getDiagnostics().experiment!.sessions[0].trackEvents).toEqual([])
    expect(session.getDiagnostics().experiment!.endedNotRecorded).toBeNull()
  })

  it('records the page events only with trace', async () => {
    const passive = await startWith('?exp=')
    passive.session.recordPageEvent('pagehide', true)
    expect(passive.session.getDiagnostics().experiment!.pageEvents).toEqual([])
    const traced = createAudioSession(makeCallbacks(), readExperimentConfig('?exp=trace'))
    traced.recordPageEvent('pageshow', false)
    traced.recordPageEvent('visibilitychange')
    traced.markTraceListenerOnly()
    const diag = traced.getDiagnostics().experiment!
    expect(diag.pageEvents.map(e => [e.type, e.persisted])).toEqual([['pageshow', false], ['visibilitychange', undefined]])
    expect(diag.pageEvents[0].visibilityState).toBe(document.visibilityState)
    expect(diag.traceListenerOnly).toBe(true)
  })

  it('does nothing for the page events and the trace listener mark without exp', () => {
    const session = createAudioSession(makeCallbacks())
    session.recordPageEvent('pagehide', true)
    session.markTraceListenerOnly()
    expect(session.getDiagnostics().experiment).toBeUndefined()
  })
})

describe('experiment: passive diagnostics', () => {
  it('records the times of the audio parts and the sizes, but not the recognized text', async () => {
    const { session, recorders, recognitions, frames } = await startWith('?exp=norecog,legacyrecog,typo')
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    frames.frame(100)
    session.stop()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['abc']) })
    recorders.instances[0].onstop?.()
    await flush()
    const diag = session.getDiagnostics().experiment!
    expect(diag.config).toEqual({
      raw: 'norecog,legacyrecog,typo',
      requested: ['norecog', 'legacyrecog'],
      ignored: ['typo'],
      inactive: [{ name: 'legacyrecog', reason: 'norecog が優先' }],
      effective: ['norecog'],
    })
    const trace = diag.sessions[0]
    expect(trace.clock.dateNow).toEqual(expect.any(Number))
    expect(trace.clock.performanceNow).toEqual(expect.any(Number))
    expect(trace.getUserMediaCalledAt).toEqual(expect.any(Number))
    expect(trace.tracksRead).toBe(true)
    expect(trace.audioContext.createdAt).toEqual(expect.any(Number))
    expect(trace.audioContext.sourceConnectedAt).toEqual(expect.any(Number))
    expect(trace.audioContext.disconnectedAt).toEqual(expect.any(Number))
    expect(trace.audioContext.closeCalledAt).toEqual(expect.any(Number))
    expect(trace.audioContext.closeResolvedAt).toEqual(expect.any(Number))
    expect(trace.recorder.startCalledAt).toEqual(expect.any(Number))
    expect(trace.recorder.stopCalls.map(c => c.by)).toEqual(['user'])
    expect(trace.recorder.data).toEqual([{ at: expect.any(Number), size: 3, activeSession: true }])
    expect(trace.recorder.onstopAt).toEqual(expect.any(Number))
    expect(trace.recorder.blobSize).toBe(3)
    expect(trace.level).toEqual({ firstSampleAt: 100, firstNonZeroAt: 100 })
  })

  it('records the recognition events with the number of characters only', async () => {
    const { session, recognitions, recorders } = await startWith('?exp=')
    const recognition = recognitions.instances[0]
    recognition.onresult?.({ results: [[{ transcript: '秘密の本文' }]] })
    recognition.onerror?.({ error: 'no-speech' })
    recognition.onend?.()
    session.stop()
    recognition.onend?.()
    recorders.instances[0].onstop?.()
    recognition.onresult?.({ results: [[{ transcript: '後から来た本文' }]] })
    const diagnostics = session.getDiagnostics()
    const events = diagnostics.experiment!.sessions[0].recognition.events
    expect(events.map(e => e.type)).toEqual(['start_call', 'result', 'error', 'end', 'start_call', 'stop_call', 'end', 'result_stale'])
    expect(events[1].chars).toBe(5)
    expect(events[2].error).toBe('no-speech')
    const json = JSON.stringify(diagnostics)
    expect(json).not.toContain('秘密の本文')
    expect(json).not.toContain('後から来た本文')
  })

  it('records the data of an invalid session as not active', async () => {
    const { session, recorders } = await startWith('?exp=')
    await session.abort('hidden')
    recorders.instances[0].ondataavailable?.({ data: new Blob(['late']) })
    const trace = session.getDiagnostics().experiment!.sessions[0]
    expect(trace.recorder.data).toEqual([{ at: expect.any(Number), size: 4, activeSession: false }])
    expect(trace.recorder.stopCalls.map(c => c.by)).toEqual(['cleanup'])
  })

  it('records the time when a later session calls getUserMedia', async () => {
    const { session, gum, recorders } = await startWith('?exp=')
    session.stop()
    recorders.instances[0].onstop?.()
    await flush()
    const started = session.start('ja-JP')
    await gum.calls[1].resolve()
    await started
    const [first, second] = session.getDiagnostics().experiment!.sessions
    expect(second.getUserMediaCalledAt!).toBeGreaterThanOrEqual(first.audioContext.closeResolvedAt!)
  })

  it('returns a copy, so the later records do not change a snapshot', async () => {
    const { session, recorders } = await startWith('?exp=')
    const before = session.getDiagnostics().experiment!
    recorders.instances[0].ondataavailable?.({ data: new Blob(['x']) })
    expect(before.sessions[0].recorder.data).toEqual([])
  })
})
