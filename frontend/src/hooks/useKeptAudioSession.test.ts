import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { RECORDER_STOP_TIMEOUT_MS, createKeptAudioSession, useKeptAudioSession } from './useKeptAudioSession'
import type {
  AudioSession, AudioSessionAbortReason, AudioSessionCallbacks, KeptAudioDiagnostics, KeptAudioSessionDiagnostics,
} from './useKeptAudioSession'
import { peekLive, resetKeptMicForTest } from '../audio/keptMic'
import {
  AUDIO_GLOBALS, endTrack, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia,
  setupMediaRecorder, setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// マイクを閉じない録音のセッション（docs/speech-flow.md）。録音の資源の安全策を確かめ、
// どの経路でも track の stop() を呼ばないことを確かめる

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let contexts: ReturnType<typeof setupAudioContext>
let frames: ReturnType<typeof setupAnimationFrame>

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  contexts = setupAudioContext()
  frames = setupAnimationFrame()
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

// 1回目の録音（getUserMedia を呼ぶ）の成立まで進める
async function startFirst(callbacks = makeCallbacks(), stream: FakeStream = makeFakeStream()) {
  const session = createKeptAudioSession(callbacks)
  const started = session.start('ja-JP')
  await gum.calls[0].resolve(stream)
  await started
  return { session, callbacks, stream }
}

// 利用者の停止をして、最後のデータと onstop を起こす
function stopAndFinish(session: AudioSession, index: number, data = 'abc') {
  session.stop()
  recorders.instances[index].ondataavailable?.({ data: new Blob([data]) })
  recorders.instances[index].onstop?.()
}

function firstCall(fn: { mock: { invocationCallOrder: number[] } }) {
  return fn.mock.invocationCallOrder[0] ?? Infinity
}

const sessionDiag = (session: AudioSession, i: number) => session.getDiagnostics().sessions[i] as KeptAudioSessionDiagnostics
const eventTypes = (session: AudioSession) => session.getDiagnostics().events.map(e => e.type)

describe('useKeptAudioSession: never stops the tracks', () => {
  const expectNoTrackStop = (stream: FakeStream) => stream.tracks.forEach(t => expect(t.stop).not.toHaveBeenCalled())

  it('on the user stop and after onstop', async () => {
    const { session, callbacks, stream } = await startFirst()
    session.stop()
    expectNoTrackStop(stream)
    recorders.instances[0].ondataavailable?.({ data: new Blob(['abc']) })
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expectNoTrackStop(stream)
    expect(session.hasActiveSession()).toBe(false)
  })

  it.each(['hidden', 'pagehide', 'back', 'unmount', 'error'] as AudioSessionAbortReason[])('on abort(%s) while recording', async (reason) => {
    const { session, stream } = await startFirst()
    await session.abort(reason)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    expectNoTrackStop(stream)
    expect(peekLive()).toBe(stream)
  })

  it.each([
    ['no audio track', [] as Parameters<typeof makeFakeStream>[0], {}],
    ['a track that is not live', [{ readyState: 'ended' }], {}],
    ['MediaRecorder creation throws', [{}], { throwOnCreate: true }],
    ['MediaRecorder start() throws', [{}], { throwOnStart: true }],
  ])('on recording_start_failed when %s', async (_, tracks, recorderOptions) => {
    setupMediaRecorder(recorderOptions)
    const stream = makeFakeStream(tracks)
    const { callbacks, session } = await startFirst(makeCallbacks(), stream)
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('recording_start_failed', expect.any(String))
    expect(callbacks.onRecordingStarted).not.toHaveBeenCalled()
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(false)
    expectNoTrackStop(stream)
  })

  it('when the recorder stops by itself before the user stop', async () => {
    const { session, callbacks, stream } = await startFirst()
    endTrack(stream.tracks[0])
    recorders.instances[0].state = 'inactive'
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(eventTypes(session)).toContain('recorder_stopped_unexpectedly')
    expect(session.hasActiveSession()).toBe(false)
    expectNoTrackStop(stream)
  })

  it('on MediaRecorder onerror', async () => {
    const { session, callbacks, stream } = await startFirst()
    recorders.instances[0].onerror?.({ error: new DOMException('x', 'UnknownError') })
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(eventTypes(session)).toContain('recorder_error:UnknownError')
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expectNoTrackStop(stream)
  })

  it('on the onstop watchdog', async () => {
    vi.useFakeTimers()
    const { session, callbacks, stream } = await startFirst()
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS - 1)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(sessionDiag(session, 0).recorder.stopTimedOut).toBe(true)
    expect(eventTypes(session)).toContain('recorder_stop_timeout')
    // 見張りで片付けた後に届いた onstop は何もしない
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expectNoTrackStop(stream)
  })

  it('when stop() throws', async () => {
    const { session, callbacks, stream } = await startFirst()
    recorders.instances[0].stop.mockImplementation(() => { throw new DOMException('x', 'InvalidStateError') })
    session.stop()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(eventTypes(session)).toContain('recorder_stop_failed:InvalidStateError')
    expectNoTrackStop(stream)
  })
})

describe('useKeptAudioSession: reusing the microphone', () => {
  it('starts MediaRecorder synchronously in start() without calling getUserMedia again', async () => {
    const { session, stream } = await startFirst()
    stopAndFinish(session, 0)
    const callbacks = makeCallbacks()
    session.setCallbacks(callbacks)
    const started = session.start('en-US')
    // await を挟まずに、同じ同期の処理の中で録音が成立している
    expect(recorders.instances).toHaveLength(2)
    expect(recorders.Ctor).toHaveBeenLastCalledWith(stream, undefined)
    expect(recorders.instances[1].start).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[1].lang).toBe('en-US')
    await started
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(sessionDiag(session, 0).getUserMedia).toMatchObject({ acquired: true, reused: false })
    expect(sessionDiag(session, 1).getUserMedia).toMatchObject({ acquired: false, reused: true, startedAt: null })
    expect(eventTypes(session)).toContain('microphone_reused')
  })

  it('creates the MediaRecorder, the AudioContext, and the recognition for every recording', async () => {
    const { session } = await startFirst()
    for (let i = 0; i < 3; i++) {
      stopAndFinish(session, i)
      await session.start('ja-JP')
    }
    expect(recorders.instances).toHaveLength(4)
    expect(contexts.instances).toHaveLength(4)
    expect(recognitions.instances).toHaveLength(4)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('does not add listeners to the track (only the ended listener of keptMic)', async () => {
    const stream = makeFakeStream()
    const spy = vi.spyOn(stream.tracks[0], 'addEventListener')
    const { session } = await startFirst(makeCallbacks(), stream)
    for (let i = 0; i < 9; i++) {
      stopAndFinish(session, i)
      await session.start('ja-JP')
    }
    expect(recorders.instances).toHaveLength(10)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('ended', expect.any(Function))
  })

  it('acquires again on the next start when the track has ended', async () => {
    const { session, stream } = await startFirst()
    stopAndFinish(session, 0)
    endTrack(stream.tracks[0])
    const started = session.start('ja-JP')
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    const next = await gum.calls[1].resolve()
    await started
    expect(recorders.Ctor).toHaveBeenLastCalledWith(next, undefined)
    expect(next.tracks[0].stop).not.toHaveBeenCalled()
  })
})

describe('useKeptAudioSession: start', () => {
  it('reports microphone_denied when getUserMedia rejects', async () => {
    const callbacks = makeCallbacks()
    const session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError'))
    await started
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('microphone_denied', 'NotAllowedError')
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(false)
    expect(sessionDiag(session, 0).getUserMedia.errorName).toBe('NotAllowedError')
  })

  it('keeps the stream that getUserMedia returns after an abort, and reuses it on the next start', async () => {
    const callbacks = makeCallbacks()
    const session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    await session.abort('hidden')
    const stream = await gum.calls[0].resolve()
    await started
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(callbacks.onRecordingStarted).not.toHaveBeenCalled()
    expect(eventTypes(session)).toContain('stale_get_user_media_kept')
    void session.start('ja-JP')
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorders.Ctor).toHaveBeenCalledWith(stream, undefined)
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
  })

  it('ignores a getUserMedia rejection after an abort', async () => {
    const callbacks = makeCallbacks()
    const session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    await session.abort('pagehide')
    await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError'))
    await started
    expect(callbacks.onStartFailed).not.toHaveBeenCalled()
  })

  it('shares the pending getUserMedia when started again while waiting', async () => {
    const callbacks = makeCallbacks()
    const session = createKeptAudioSession(callbacks)
    const first = session.start('ja-JP')
    await session.abort('hidden')
    const second = session.start('ja-JP')
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    await gum.calls[0].resolve()
    await Promise.all([first, second])
    expect(recorders.instances).toHaveLength(1)
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(true)
  })

  it('tears down a leftover session when start is called twice, without stopping the tracks', async () => {
    const { session, stream } = await startFirst()
    await session.start('ja-JP')
    expect(eventTypes(session)).toContain('unexpected_active_session_on_start')
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.instances[1].start).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(true)
  })

  it('keeps recording when the level meter and the recognition fail', async () => {
    setupSpeechRecognition({ throwOnCreate: true })
    setupAudioContext({ throwOnCreate: true })
    const { session, callbacks } = await startFirst()
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(eventTypes(session)).toEqual(expect.arrayContaining(['level_meter_failed:Error', 'recognition_failed:Error']))
    stopAndFinish(session, 0)
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
  })

  it('records recognition_unavailable when there is no SpeechRecognition', async () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition
    const { session } = await startFirst()
    expect(eventTypes(session)).toContain('recognition_unavailable')
  })

  it('does not start the level meter and the recognition when aborted in onRecordingStarted', async () => {
    let session: AudioSession | null = null
    const callbacks = makeCallbacks({ onRecordingStarted: vi.fn(() => { void session!.abort('error') }) })
    session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(contexts.instances).toHaveLength(0)
    expect(recognitions.Ctor).not.toHaveBeenCalled()
  })

  it('does not start the level meter and the recognition after a user stop in onRecordingStarted (KK4, KK5)', async () => {
    // 今の画面からは起きない経路。onRecordingStarted の中で利用者の停止を呼ぶと、abort と違ってセッションは有効のまま
    // 止める指示が出た状態で、start が音量の取得と音声認識を始めようとする
    let session: AudioSession | null = null
    const callbacks = makeCallbacks({ onRecordingStarted: vi.fn(() => session!.stop()) })
    session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    const stream = await gum.calls[0].resolve()
    await started
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(true)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    // KK4：AudioContext を作らず、requestAnimationFrame も頼まない
    expect(contexts.Ctor).not.toHaveBeenCalled()
    expect(frames.request).not.toHaveBeenCalled()
    // KK5：音声認識の constructor も start() も呼ばない
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    expect(recognitions.instances).toEqual([])
    expect(eventTypes(session)).not.toContain('recognition_unavailable')
    // onstop の後は送り、track は止めない
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })
})

describe('useKeptAudioSession: user stop', () => {
  it('stops the recognition, the RAF, disconnect(), close(), then MediaRecorder stop()', async () => {
    const { session } = await startFirst()
    const ctx = contexts.instances[0]
    session.stop()
    const order = [
      firstCall(recognitions.instances[0].stop),
      firstCall(frames.cancel),
      firstCall(ctx.source.disconnect),
      firstCall(ctx.close),
      firstCall(recorders.instances[0].stop),
    ]
    expect(order.every(n => n !== Infinity)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('hands over the blob of all the data after onstop', async () => {
    const { session, callbacks } = await startFirst()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['ab']) })
    session.stop()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['cde']) })
    recorders.instances[0].ondataavailable?.({ data: new Blob([]) })
    recorders.instances[0].onstop?.()
    const blob = vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0] as Blob
    expect(blob.size).toBe(5)
    expect(blob.type).toBe('audio/webm')
    expect(sessionDiag(session, 0).recorder.bytes).toBe(5)
    expect(sessionDiag(session, 0).stopReason).toBe('user')
  })

  it('waits for onstop and hands over the data when the recorder has become inactive by itself', async () => {
    const { session, callbacks } = await startFirst()
    recorders.instances[0].state = 'inactive'
    session.stop()
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    expect(eventTypes(session)).toContain('recorder_already_inactive')
    recorders.instances[0].ondataavailable?.({ data: new Blob(['whole']) })
    recorders.instances[0].onstop?.()
    expect((vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0] as Blob).size).toBe(5)
  })

  it('does not send when onstop had already arrived before the user stop', async () => {
    const { session, callbacks } = await startFirst()
    recorders.instances[0].state = 'inactive'
    recorders.instances[0].onstop?.()
    session.stop()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
  })

  it('ignores stop while getUserMedia is pending and a second stop', async () => {
    const callbacks = makeCallbacks()
    const session = createKeptAudioSession(callbacks)
    const started = session.start('ja-JP')
    session.stop()
    await gum.calls[0].resolve()
    await started
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    session.stop()
    session.stop()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('sends without a failure when onstop arrives before the watchdog', async () => {
    vi.useFakeTimers()
    const { session, callbacks } = await startFirst()
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS - 1)
    recorders.instances[0].onstop?.()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(sessionDiag(session, 0).recorder.stopLatencyMs).toBe(RECORDER_STOP_TIMEOUT_MS - 1)
    expect(sessionDiag(session, 0).recorder.stopTimedOut).toBe(false)
    expect(sessionDiag(session, 0).recorder.stopWaitedMs).toBeNull()
  })

  it('records the time it waited on the watchdog, and the latency of a late onstop', async () => {
    vi.useFakeTimers()
    const { session, callbacks } = await startFirst()
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    const recorderDiag = sessionDiag(session, 0).recorder
    expect(recorderDiag.stopTimedOut).toBe(true)
    expect(recorderDiag.stopWaitedMs).toBe(RECORDER_STOP_TIMEOUT_MS)
    expect(recorderDiag.stopLatencyMs).toBeNull()
    // 後から onstop が届いても送らない。届くまでの時間は残す
    vi.advanceTimersByTime(250)
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(sessionDiag(session, 0).recorder.stopLatencyMs).toBe(RECORDER_STOP_TIMEOUT_MS + 250)
  })

  it('measures the time from the stop instruction when the recorder had become inactive by itself (JJ7)', async () => {
    vi.useFakeTimers()
    const { session, callbacks } = await startFirst()
    recorders.instances[0].state = 'inactive'
    session.stop()
    vi.advanceTimersByTime(120)
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(sessionDiag(session, 0).recorder.stopLatencyMs).toBe(120)
  })

  it('waits for the close() started by the user stop when aborted while stopping (KK1)', async () => {
    const { session } = await startFirst()
    const ctx = contexts.instances[0]
    let finishClose!: () => void
    ctx.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = () => { ctx.state = 'closed'; resolve() } }))
    session.stop()
    expect(ctx.close).toHaveBeenCalledTimes(1)
    let settled = false
    const aborted = session.abort('pagehide').then(() => { settled = true })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(settled).toBe(false)
    finishClose()
    await aborted
    expect(settled).toBe(true)
    // close() と disconnect() は、利用者の停止で1回だけ
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(ctx.source.disconnect).toHaveBeenCalledTimes(1)
    expect(sessionDiag(session, 0).audioContext.state).toBe('closed')
  })

  it('resolves the abort while stopping without an unhandled rejection when close() rejects (KK1)', async () => {
    // 未処理の拒否は Node の process に届く（frontend の型には Node がないので、必要なところだけ型を書く）
    type UnhandledListener = (reason: unknown) => void
    const proc = (globalThis as unknown as {
      process: { on: (e: string, l: UnhandledListener) => void; off: (e: string, l: UnhandledListener) => void }
    }).process
    const unhandled = vi.fn()
    proc.on('unhandledRejection', unhandled)
    try {
      const { session } = await startFirst()
      const ctx = contexts.instances[0]
      let failClose!: () => void
      ctx.close.mockImplementation(() => new Promise<void>((_, reject) => { failClose = () => reject(new Error('close failed')) }))
      session.stop()
      const aborted = session.abort('hidden')
      failClose()
      await expect(aborted).resolves.toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(ctx.close).toHaveBeenCalledTimes(1)
      expect(ctx.source.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      proc.off('unhandledRejection', unhandled)
    }
  })

  it('does not let the watchdog of session 1 act on session 2', async () => {
    vi.useFakeTimers()
    const { session, callbacks } = await startFirst()
    session.stop()
    await session.abort('hidden')
    await session.start('ja-JP')
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(true)
  })
})

describe('useKeptAudioSession: recognition restart', () => {
  it('restarts on onend only while the session is valid, the screen is recording, and before the stop request', async () => {
    let recording = true
    const { session } = await startFirst(makeCallbacks({ isRecordingStatus: vi.fn(() => recording) }))
    const recognition = recognitions.instances[0]
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    recording = false
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    recording = true
    session.stop()
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
  })

  it('does not restart after an abort, and ignores the results of the old session', async () => {
    const { session, callbacks } = await startFirst()
    const recognition1 = recognitions.instances[0]
    await session.abort('hidden')
    await session.start('ja-JP')
    recognition1.onend?.()
    recognition1.onresult?.({ results: [[{ transcript: '古い' }]] })
    recognition1.onerror?.({ error: 'network' })
    expect(recognition1.start).toHaveBeenCalledTimes(1)
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
    expect(eventTypes(session)).not.toContain('recognition_error:network')
  })

  it('passes the transcript and records only the number of characters', async () => {
    const { session, callbacks } = await startFirst()
    recognitions.instances[0].onresult?.({ results: [[{ transcript: 'こんに' }], [{ transcript: 'ちは' }]] })
    recognitions.instances[0].onerror?.()
    expect(callbacks.onTranscript).toHaveBeenCalledWith('こんにちは')
    expect(sessionDiag(session, 0).recognition).toEqual({ hadResult: true, chars: 5 })
    expect(eventTypes(session)).toContain('recognition_error:unknown')
    expect(JSON.stringify(session.getDiagnostics())).not.toContain('こんにちは')
  })

  it('swallows a restart failure', async () => {
    await startFirst()
    const recognition = recognitions.instances[0]
    recognition.start.mockImplementation(() => { throw new Error('x') })
    expect(() => recognition.onend?.()).not.toThrow()
  })
})

describe('useKeptAudioSession: stale callbacks and cleanup', () => {
  it('ignores the late data and onstop of the old session while the new session records', async () => {
    const { session, callbacks } = await startFirst()
    const recorder1 = recorders.instances[0]
    await session.abort('hidden')
    await session.start('ja-JP')
    recorder1.ondataavailable?.({ data: new Blob(['old']) })
    recorder1.onstop?.()
    recorder1.onerror?.({})
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    stopAndFinish(session, 1, 'new!')
    expect((vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0] as Blob).size).toBe(4)
  })

  it('updates the level and stops the level meter of the old session', async () => {
    const { session, callbacks } = await startFirst()
    frames.frame(16)
    expect(callbacks.onLevel).toHaveBeenCalledTimes(1)
    expect(sessionDiag(session, 0).level.samples).toBe(1)
    await session.abort('hidden')
    frames.frame(32)
    expect(callbacks.onLevel).toHaveBeenCalledTimes(1)
  })

  it('can be called again and again without double stops or exceptions', async () => {
    const { session, stream } = await startFirst()
    await session.abort('hidden')
    await session.abort('pagehide')
    await session.abort('back')
    await session.abort('unmount')
    session.stop()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })

  it('swallows the errors of the cleanup', async () => {
    setupSpeechRecognition({ throwOnStop: true })
    setupAudioContext({ closeRejects: true })
    const { session } = await startFirst()
    await expect(session.abort('hidden')).resolves.toBeUndefined()
  })

  it('swallows a synchronous exception of close() and disconnect()', async () => {
    const { session } = await startFirst()
    const ctx = contexts.instances[0]
    ctx.close.mockImplementation(() => { throw new Error('x') })
    ctx.source.disconnect.mockImplementation(() => { throw new Error('x') })
    await expect(session.abort('hidden')).resolves.toBeUndefined()
  })

  it('does not close an AudioContext that is already closed', async () => {
    const { session } = await startFirst()
    contexts.instances[0].state = 'closed'
    await session.abort('hidden')
    expect(contexts.instances[0].close).not.toHaveBeenCalled()
  })

  it('does nothing when there is no session', async () => {
    const session = createKeptAudioSession(makeCallbacks())
    await expect(session.abort('hidden')).resolves.toBeUndefined()
    session.stop()
    expect(session.hasActiveSession()).toBe(false)
  })

  it('keeps only the latest sessions and events', async () => {
    const { session } = await startFirst()
    for (let i = 0; i < 12; i++) {
      stopAndFinish(session, i)
      await session.start('ja-JP')
    }
    for (let i = 0; i < 250; i++) session.logEvent('x')
    const diagnostics = session.getDiagnostics()
    expect(diagnostics.sessions).toHaveLength(10)
    expect(diagnostics.sessions.at(-1)!.id).toBe(13)
    expect(diagnostics.events).toHaveLength(200)
    expect(diagnostics).not.toHaveProperty('experiment')
  })
})

describe('useKeptAudioSession hooks', () => {
  it('returns the same session across renders and uses the latest callbacks', async () => {
    const first = makeCallbacks()
    const { result, rerender } = renderHook(({ callbacks }) => useKeptAudioSession(callbacks), { initialProps: { callbacks: first } })
    const session = result.current
    const second = makeCallbacks()
    rerender({ callbacks: second })
    expect(result.current).toBe(session)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(second.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(first.onRecordingStarted).not.toHaveBeenCalled()
  })

  it('puts the keptMic diagnostics into getDiagnostics()', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    const { result } = renderHook(() => useKeptAudioSession(makeCallbacks()))
    const session = result.current
    const started = session.start('ja-JP')
    const stream = await gum.calls[0].resolve()
    await started
    expect((session.getDiagnostics() as KeptAudioDiagnostics).keptMic).toEqual({ getUserMediaCalls: 1, endedEvents: [] })
    endTrack(stream.tracks[0])
    expect((session.getDiagnostics() as KeptAudioDiagnostics).keptMic).toEqual({ getUserMediaCalls: 1, endedEvents: [{ at: 5000, track: 0 }] })
  })
})
