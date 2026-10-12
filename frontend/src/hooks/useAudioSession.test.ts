import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { RECORDER_STOP_TIMEOUT_MS, createAudioSession, useAudioSession } from './useAudioSession'
import type { AudioSessionCallbacks } from './useAudioSession'
import {
  AUDIO_GLOBALS, endTrack, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia,
  setupMediaRecorder, setupSpeechRecognition,
} from '../test/audioMocks'

let restoreGlobals: () => void

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
})

afterEach(() => {
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

// 録音の成立まで進める
async function startRecording(callbacks = makeCallbacks()) {
  const gum = setupDeferredGetUserMedia()
  const recorders = setupMediaRecorder()
  const recognitions = setupSpeechRecognition()
  const contexts = setupAudioContext()
  const frames = setupAnimationFrame()
  const session = createAudioSession(callbacks)
  const started = session.start('ja-JP')
  const stream = await gum.calls[0].resolve()
  await started
  return { session, callbacks, gum, recorders, recognitions, contexts, frames, stream }
}

// 先に呼ばれた mock の呼び出しの順番（vitest の invocationCallOrder）。呼ばれていなければ Infinity
function firstCall(fn: { mock: { invocationCallOrder: number[] } }) {
  return fn.mock.invocationCallOrder[0] ?? Infinity
}

describe('useAudioSession: recording start', () => {
  it('starts the recorder, the level meter, and the recognition after the recording is established', async () => {
    const { callbacks, recorders, recognitions, contexts, frames, session } = await startRecording()
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].start).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].lang).toBe('ja-JP')
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
    expect(contexts.instances).toHaveLength(1)
    expect(frames.pendingCount()).toBe(1)
    expect(session.hasActiveSession()).toBe(true)
  })

  it('reports microphone_denied and keeps nothing when getUserMedia rejects', async () => {
    const gum = setupDeferredGetUserMedia()
    const recorders = setupMediaRecorder()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError'))
    await started
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('microphone_denied', 'NotAllowedError')
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(false)
    expect(session.getDiagnostics().sessions[0].getUserMedia.errorName).toBe('NotAllowedError')
  })

  it.each([
    ['no audio track', [] as Parameters<typeof makeFakeStream>[0], {}],
    ['a track that is not live', [{ readyState: 'ended' }], {}],
    ['MediaRecorder creation throws', [{}], { throwOnCreate: true }],
    ['MediaRecorder start() throws', [{}], { throwOnStart: true }],
  ])('reports recording_start_failed and stops every track when %s', async (_, tracks, recorderOptions) => {
    const gum = setupDeferredGetUserMedia()
    setupMediaRecorder(recorderOptions)
    const recognitions = setupSpeechRecognition()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    const stream = makeFakeStream(tracks)
    // 動画の track も含めて、すべての track を閉じること
    stream.tracks.push(...makeFakeStream([{ kind: 'video' }]).tracks)
    await gum.calls[0].resolve(stream)
    await started
    expect(callbacks.onStartFailed).toHaveBeenCalledWith('recording_start_failed', expect.any(String))
    expect(callbacks.onRecordingStarted).not.toHaveBeenCalled()
    stream.tracks.forEach(t => expect(t.stop).toHaveBeenCalledTimes(1))
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(false)
  })

  it('keeps recording when the level meter and the recognition fail (3.11-4)', async () => {
    const gum = setupDeferredGetUserMedia()
    const recorders = setupMediaRecorder({ autoStop: true })
    setupSpeechRecognition({ throwOnCreate: true })
    setupAudioContext({ throwOnCreate: true })
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(callbacks.onRecordingStarted).toHaveBeenCalledTimes(1)
    expect(callbacks.onStartFailed).not.toHaveBeenCalled()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['audio']) })
    session.stop()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    const types = session.getDiagnostics().events.map(e => e.type)
    expect(types).toContain('level_meter_failed:Error')
    expect(types).toContain('recognition_failed:Error')
  })

  it('records recognition_unavailable when there is no SpeechRecognition', async () => {
    const gum = setupDeferredGetUserMedia()
    setupMediaRecorder()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(callbacks.onRecordingStarted).toHaveBeenCalled()
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recognition_unavailable')
  })

  it('stops the stream of getUserMedia that resolves after an abort (3.11-2)', async () => {
    const gum = setupDeferredGetUserMedia()
    const recorders = setupMediaRecorder()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    await session.abort('hidden')
    const stream = await gum.calls[0].resolve()
    await started
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(callbacks.onRecordingStarted).not.toHaveBeenCalled()
  })

  it('ignores a getUserMedia rejection after an abort', async () => {
    const gum = setupDeferredGetUserMedia()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    const started = session.start('ja-JP')
    await session.abort('pagehide')
    await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError'))
    await started
    expect(callbacks.onStartFailed).not.toHaveBeenCalled()
  })

  it('tears down a leftover session when start is called twice', async () => {
    const { session, stream, recorders, gum } = await startRecording()
    const second = session.start('en-US')
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('unexpected_active_session_on_start')
    await gum.calls[1].resolve()
    await second
    expect(session.hasActiveSession()).toBe(true)
  })
})

describe('useAudioSession: user stop', () => {
  it('closes the AudioContext and disconnects the source before MediaRecorder stop() on a user stop (iPhone Chrome)', async () => {
    const { session, recorders, contexts, stream } = await startRecording()
    const recorder = recorders.instances[0]
    const ctx = contexts.instances[0]
    session.stop()
    // close() の完了は待たずに、MediaRecorder の stop() を呼ぶ
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(ctx.source.disconnect).toHaveBeenCalledTimes(1)
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(firstCall(ctx.source.disconnect)).toBeLessThan(firstCall(recorder.stop))
    expect(firstCall(ctx.close)).toBeLessThan(firstCall(recorder.stop))
    recorder.onstop?.()
    expect(firstCall(ctx.close)).toBeLessThan(firstCall(stream.tracks[0].stop))
    // onstop の後の片付けで、二重に close() や disconnect() をしない
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(ctx.source.disconnect).toHaveBeenCalledTimes(1)
  })

  it('waits for onstop, then stops the tracks before handing over the blob (3.11-5)', async () => {
    const { session, callbacks, recorders, recognitions, contexts, frames, stream } = await startRecording(
      makeCallbacks({ onRecordingStopped: vi.fn(() => { expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1) }) }),
    )
    const recorder = recorders.instances[0]
    recorder.ondataavailable?.({ data: new Blob(['ab']) })
    session.stop()
    // 止める指示の後は、音声認識と音量の取得を止め、MediaRecorder の onstop を待つ
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(frames.cancel).toHaveBeenCalledTimes(1)
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    // 最後の ondataavailable の後の onstop で送る
    recorder.ondataavailable?.({ data: new Blob(['cde']) })
    recorder.onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    const blob = vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0]
    expect(blob.size).toBe(5)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    // 音声認識の onend は始め直さない（3.11-7）
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
  })

  it('does not restart the recognition after the stop request even while the recorder is still recording (3.11-7)', async () => {
    const { session, recognitions, recorders } = await startRecording()
    session.stop()
    expect(recorders.instances[0].state).toBe('inactive')
    // 本物と違って state が recording のままでも、止める指示が出ていれば始め直さない
    recorders.instances[0].state = 'recording'
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
  })

  it('restarts the recognition on onend only while the session is valid and the screen is recording', async () => {
    let recording = true
    const { recognitions } = await startRecording(makeCallbacks({ isRecordingStatus: () => recording }))
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(2)
    recording = false
    recognitions.instances[0].onend?.()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(2)
  })

  it('waits for onstop and sends the last data when the recorder has become inactive by itself (JJ1)', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    const recorder = recorders.instances[0]
    // MediaRecorder が自分で inactive になり、dataavailable と stop のイベントはまだ届いていない
    recorder.state = 'inactive'
    session.stop()
    expect(recorder.stop).not.toHaveBeenCalled()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(true)
    // timeslice なしの録音では、最後の dataavailable が録音の全体になる
    recorder.ondataavailable?.({ data: new Blob(['whole']) })
    recorder.onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0].size).toBe(5)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
  })

  it('does not send when onstop had already arrived before the user stop (JJ1)', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    recorders.instances[0].state = 'inactive'
    recorders.instances[0].onstop?.()
    session.stop()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recorder_stopped_unexpectedly')
  })

  it('treats a stop() exception as a recording failure and does not send (JJ1)', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['part']) })
    recorders.instances[0].stop.mockImplementation(() => { throw new DOMException('x', 'InvalidStateError') })
    session.stop()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recorder_stop_failed:InvalidStateError')
    // 後から onstop が届いても送らない
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
  })

  it('ignores stop while getUserMedia is pending and a second stop', async () => {
    const gum = setupDeferredGetUserMedia()
    const callbacks = makeCallbacks()
    const session = createAudioSession(callbacks)
    void session.start('ja-JP')
    session.stop()
    expect(session.hasActiveSession()).toBe(true)
    await gum.calls[0].reject(new Error('x'))
    session.stop()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
  })
})

describe('useAudioSession: onstop watchdog (JJ2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails the recording when onstop does not arrive within RECORDER_STOP_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders, stream } = await startRecording()
    recorders.instances[0].ondataavailable?.({ data: new Blob(['part']) })
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS - 1)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recorder_stop_timeout')
    // 見張りのタイマーで片付けたことと、待った時間が診断の情報に残る
    const recorderDiag = session.getDiagnostics().sessions[0].recorder
    expect(recorderDiag.stopTimedOut).toBe(true)
    expect(recorderDiag.stopWaitedMs).toBe(RECORDER_STOP_TIMEOUT_MS)
    expect(recorderDiag.stopLatencyMs).toBeNull()
    // 後から onstop が届いても送らない。届くまでの時間は残す
    vi.advanceTimersByTime(250)
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(session.getDiagnostics().sessions[0].recorder.stopLatencyMs).toBe(RECORDER_STOP_TIMEOUT_MS + 250)
  })

  it('also watches when the recorder had become inactive by itself', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders } = await startRecording()
    recorders.instances[0].state = 'inactive'
    session.stop()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
  })

  it('sends without a failure when onstop arrives in the 9-second range (JJ7)', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders } = await startRecording()
    const delay = RECORDER_STOP_TIMEOUT_MS - 500
    expect(Math.floor(delay / 1000)).toBe(9)
    recorders.instances[0].ondataavailable?.({ data: new Blob(['long']) })
    session.stop()
    vi.advanceTimersByTime(delay)
    recorders.instances[0].onstop?.()
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS)
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0].size).toBe(4)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    // stop() から onstop までの時間が診断の情報に残る
    const recorderDiag = session.getDiagnostics().sessions[0].recorder
    expect(recorderDiag.stopLatencyMs).toBe(delay)
    expect(recorderDiag.stopTimedOut).toBe(false)
    expect(recorderDiag.stopWaitedMs).toBeNull()
  })

  it('measures the time from the stop instruction when the recorder had become inactive by itself (JJ7)', async () => {
    vi.useFakeTimers()
    const { session, callbacks, recorders } = await startRecording()
    recorders.instances[0].state = 'inactive'
    session.stop()
    vi.advanceTimersByTime(120)
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().sessions[0].recorder.stopLatencyMs).toBe(120)
  })

  it('does nothing when the session is aborted while waiting', async () => {
    vi.useFakeTimers()
    const { session, callbacks } = await startRecording()
    session.stop()
    await session.abort('hidden')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS * 2)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
  })

  it('does not let the timer of session 1 act on session 2', async () => {
    vi.useFakeTimers()
    const { session, callbacks, gum, recorders } = await startRecording()
    session.stop()
    await session.abort('hidden')
    const second = session.start('ja-JP')
    const stream2 = await gum.calls[1].resolve()
    await second
    vi.advanceTimersByTime(RECORDER_STOP_TIMEOUT_MS * 2)
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(true)
    expect(stream2.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances[1].stop).not.toHaveBeenCalled()
  })
})

describe('useAudioSession: the recording stops by itself (JJ5)', () => {
  it('fails the recording when the track ends and the recorder stops before the user stop', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    const recorder = recorders.instances[0]
    endTrack(stream.tracks[0])
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('track_ended')
    expect(session.getDiagnostics().sessions[0].tracks[0].readyState).toBe('ended')
    // MediaRecorder が自分で止まる
    recorder.state = 'inactive'
    recorder.ondataavailable?.({ data: new Blob(['part']) })
    recorder.onstop?.()
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recorder_stopped_unexpectedly')
    expect(session.getDiagnostics().sessions[0].stopReason).toBe('error')
  })

  it('does nothing for ended after the user stop', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    session.stop()
    endTrack(stream.tracks[0])
    expect(session.getDiagnostics().events.map(e => e.type)).not.toContain('track_ended')
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).toHaveBeenCalledTimes(1)
  })

  it('does not let ended of session 1 act on session 2', async () => {
    const { session, callbacks, gum, stream } = await startRecording()
    await session.abort('hidden')
    const second = session.start('ja-JP')
    await gum.calls[1].resolve()
    await second
    endTrack(stream.tracks[0])
    expect(session.getDiagnostics().events.filter(e => e.type === 'track_ended')).toEqual([])
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()
    expect(session.hasActiveSession()).toBe(true)
  })
})

describe('useAudioSession: abort', () => {
  it.each(['hidden', 'pagehide', 'back', 'unmount', 'error'] as const)(
    'closes the AudioContext and disconnects the source before the track stop() on abort (%s)',
    async (reason) => {
      const { session, recorders, contexts, stream } = await startRecording()
      const ctx = contexts.instances[0]
      const track = stream.tracks[0]
      await session.abort(reason)
      expect(track.stop).toHaveBeenCalledTimes(1)
      expect(firstCall(ctx.source.disconnect)).toBeLessThan(firstCall(track.stop))
      expect(firstCall(ctx.close)).toBeLessThan(firstCall(track.stop))
      expect(firstCall(ctx.close)).toBeLessThan(firstCall(recorders.instances[0].stop))
    },
  )

  it('closes the AudioContext and disconnects the source before the track stop() on a MediaRecorder error', async () => {
    const { recorders, contexts, stream } = await startRecording()
    const ctx = contexts.instances[0]
    const track = stream.tracks[0]
    recorders.instances[0].onerror?.({ error: new DOMException('x', 'UnknownError') })
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(firstCall(ctx.source.disconnect)).toBeLessThan(firstCall(track.stop))
    expect(firstCall(ctx.close)).toBeLessThan(firstCall(track.stop))
  })

  it('closes the AudioContext and disconnects the source before the track stop() when the recorder stops by itself', async () => {
    const { recorders, contexts, stream } = await startRecording()
    const ctx = contexts.instances[0]
    const track = stream.tracks[0]
    recorders.instances[0].state = 'inactive'
    recorders.instances[0].onstop?.()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(firstCall(ctx.source.disconnect)).toBeLessThan(firstCall(track.stop))
    expect(firstCall(ctx.close)).toBeLessThan(firstCall(track.stop))
  })

  it('invalidates the session first, so the later onstop and data do nothing (3.11-6)', async () => {
    const { session, callbacks, recorders, recognitions, stream } = await startRecording()
    const recorder = recorders.instances[0]
    await session.abort('hidden')
    expect(session.hasActiveSession()).toBe(false)
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    recorder.ondataavailable?.({ data: new Blob(['late']) })
    recorder.onstop?.()
    recognitions.instances[0].onresult?.({ results: [[{ transcript: 'late' }]] })
    recognitions.instances[0].onerror?.({ error: 'aborted' })
    recognitions.instances[0].onend?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
    expect(recognitions.instances[0].start).toHaveBeenCalledTimes(1)
    expect(session.getDiagnostics().sessions[0].stopReason).toBe('hidden')
  })

  it('aborts in the middle of a user stop without sending the data', async () => {
    const { session, callbacks, recorders } = await startRecording()
    session.stop()
    await session.abort('pagehide')
    recorders.instances[0].onstop?.()
    expect(callbacks.onRecordingStopped).not.toHaveBeenCalled()
    expect(session.getDiagnostics().sessions[0].stopReason).toBe('pagehide')
  })

  it('can be called again and again without double stops or exceptions (3.11-8)', async () => {
    const { session, recorders, recognitions, contexts, frames, stream } = await startRecording()
    await session.abort('hidden')
    await session.abort('pagehide')
    await session.abort('back')
    await session.abort('unmount')
    session.stop()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].source.disconnect).toHaveBeenCalledTimes(1)
    expect(frames.cancel).toHaveBeenCalledTimes(1)
  })

  it('swallows the errors of the cleanup (recognition stop, AudioContext close, disconnect)', async () => {
    const gum = setupDeferredGetUserMedia()
    setupMediaRecorder()
    setupSpeechRecognition({ throwOnStop: true })
    const contexts = setupAudioContext({ closeRejects: true })
    setupAnimationFrame()
    const session = createAudioSession(makeCallbacks())
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    contexts.instances[0].source.disconnect.mockImplementation(() => { throw new Error('x') })
    await expect(session.abort('error')).resolves.toBeUndefined()
  })

  it('swallows a synchronous exception of AudioContext close()', async () => {
    const { session, contexts } = await startRecording()
    contexts.instances[0].close.mockImplementation(() => { throw new Error('x') })
    await expect(session.abort('error')).resolves.toBeUndefined()
  })

  it('records a recognition error without an event as unknown', async () => {
    const { session, recognitions } = await startRecording()
    recognitions.instances[0].onerror?.()
    expect(session.getDiagnostics().events.map(e => e.type)).toContain('recognition_error:unknown')
  })

  it('does not close an AudioContext that is already closed', async () => {
    const { session, contexts } = await startRecording()
    contexts.instances[0].state = 'closed'
    await session.abort('unmount')
    expect(contexts.instances[0].close).not.toHaveBeenCalled()
  })

  it('cleans up and reports a MediaRecorder error, and the session ends', async () => {
    const { session, callbacks, recorders, stream } = await startRecording()
    recorders.instances[0].onerror?.({ error: new DOMException('x', 'UnknownError') })
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(session.hasActiveSession()).toBe(false)
    expect(session.getDiagnostics().sessions[0].recorder.errorName).toBe('UnknownError')
    // 無効になった後の onerror は何もしない
    recorders.instances[0].onerror?.({})
    expect(callbacks.onRecorderError).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no session', async () => {
    const session = createAudioSession(makeCallbacks())
    await expect(session.abort('unmount')).resolves.toBeUndefined()
  })
})

describe('useAudioSession: stale callbacks (3.11-11)', () => {
  it('ignores every callback of the old session while the new session records', async () => {
    const { session, callbacks, gum, recorders, recognitions, stream } = await startRecording()
    const [recorder1] = recorders.instances
    const [recognition1] = recognitions.instances
    await session.abort('hidden')
    const second = session.start('en-US')
    const stream2 = await gum.calls[1].resolve()
    await second
    const recorder2 = recorders.instances[1]

    recorder1.ondataavailable?.({ data: new Blob(['old']) })
    recorder1.onstop?.()
    recorder1.onerror?.({})
    recognition1.onresult?.({ results: [[{ transcript: 'old' }]] })
    recognition1.onend?.()

    expect(session.hasActiveSession()).toBe(true)
    expect(recorder2.stop).not.toHaveBeenCalled()
    expect(stream2.tracks[0].stop).not.toHaveBeenCalled()
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recognition1.start).toHaveBeenCalledTimes(1)
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
    expect(callbacks.onRecorderError).not.toHaveBeenCalled()

    recorder2.ondataavailable?.({ data: new Blob(['new']) })
    session.stop()
    recorder2.onstop?.()
    const blob = vi.mocked(callbacks.onRecordingStopped).mock.calls[0][0]
    expect(blob.size).toBe(3)
  })

  it('stops the level meter of the old session', async () => {
    const { session, frames, callbacks } = await startRecording()
    frames.frame(16)
    expect(callbacks.onLevel).toHaveBeenCalledTimes(1)
    await session.abort('hidden')
    frames.frame(32)
    expect(callbacks.onLevel).toHaveBeenCalledTimes(1)
    expect(frames.pendingCount()).toBe(0)
  })
})

describe('useAudioSession: diagnostics', () => {
  it('keeps the numbers of each recording but not the speech', async () => {
    const { session, recorders, recognitions, frames } = await startRecording()
    frames.frame(16)
    frames.frame(32)
    recognitions.instances[0].onresult?.({ results: [[{ transcript: '秘密の' }], [{ transcript: '発話' }]] })
    recorders.instances[0].ondataavailable?.({ data: new Blob(['1234']) })
    recorders.instances[0].ondataavailable?.({ data: new Blob([]) })
    session.logEvent('status:stopping')
    session.stop()
    recorders.instances[0].onstop?.()

    const { sessions, events } = session.getDiagnostics()
    const d = sessions[0]
    expect(d.id).toBe(1)
    expect(d.stopReason).toBe('user')
    expect(d.getUserMedia.startedAt).not.toBeNull()
    expect(d.getUserMedia.succeededAt).not.toBeNull()
    expect(d.tracks).toEqual([{ readyState: 'live', enabled: true, muted: false }])
    expect(d.recorder.bytes).toBe(4)
    expect(d.recorder.durationMs).not.toBeNull()
    expect(d.recorder.state).toBe('inactive')
    expect(d.level.samples).toBe(2)
    expect(d.level.rms).toBeCloseTo(0.5)
    expect(d.level.rmsMax).toBeCloseTo(0.5)
    expect(d.level.peak).toBeCloseTo(0.5)
    expect(d.recognition).toEqual({ hadResult: true, chars: 5 })
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['get_user_media_start', 'recording_started', 'status:stopping', 'user_stop', 'recording_stopped']))
    expect(JSON.stringify(session.getDiagnostics())).not.toMatch(/秘密|発話/)
  })

  it('keeps only the latest sessions and events', async () => {
    setupDeferredGetUserMedia()
    const session = createAudioSession(makeCallbacks())
    for (let i = 0; i < 12; i++) {
      void session.start('ja-JP')
      await session.abort('hidden')
    }
    for (let i = 0; i < 250; i++) session.logEvent('x')
    const { sessions, events } = session.getDiagnostics()
    expect(sessions).toHaveLength(10)
    expect(sessions[0].id).toBe(3)
    expect(events).toHaveLength(200)
  })
})

describe('useAudioSession hook', () => {
  it('returns the same session across renders and uses the latest callbacks', async () => {
    const gum = setupDeferredGetUserMedia()
    setupMediaRecorder()
    const first = makeCallbacks()
    const second = makeCallbacks()
    const { result, rerender } = renderHook(({ cb }) => useAudioSession(cb), { initialProps: { cb: first } })
    const session = result.current
    rerender({ cb: second })
    expect(result.current).toBe(session)
    const started = session.start('ja-JP')
    await gum.calls[0].resolve()
    await started
    expect(first.onRecordingStarted).not.toHaveBeenCalled()
    expect(second.onRecordingStarted).toHaveBeenCalledTimes(1)
  })
})
