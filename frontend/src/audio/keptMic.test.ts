import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { acquire, endedEvents, getUserMediaCalls, peekLive, resetKeptMicForTest } from './keptMic'
import { AUDIO_GLOBALS, endTrack, makeFakeStream, saveGlobals, setupDeferredGetUserMedia } from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// ページ全体で1つのマイク（docs/speech-flow.md の「マイクの持ち方」）

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
})

afterEach(() => {
  vi.restoreAllMocks()
  restoreGlobals()
})

// track の addEventListener の呼び出しを数える
function spyListeners(stream: FakeStream) {
  return stream.tracks.map(track => vi.spyOn(track, 'addEventListener'))
}

async function acquireWith(index: number, stream: FakeStream = makeFakeStream()) {
  const promise = acquire()
  await gum.calls[index].resolve(stream)
  return promise
}

describe('keptMic', () => {
  it('returns null from peekLive() before acquiring', () => {
    expect(peekLive()).toBeNull()
    expect(getUserMediaCalls()).toBe(0)
  })

  it('returns the same stream from the second time without calling getUserMedia', async () => {
    const stream = makeFakeStream()
    expect(await acquireWith(0, stream)).toBe(stream)
    expect(gum.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(peekLive()).toBe(stream)
    expect(peekLive()).toBe(stream)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMediaCalls()).toBe(1)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })

  it('stops the old tracks and acquires again when a track has ended', async () => {
    const old = makeFakeStream([{}, {}])
    await acquireWith(0, old)
    endTrack(old.tracks[1])
    expect(peekLive()).toBeNull()
    const next = makeFakeStream()
    expect(await acquireWith(1, next)).toBe(next)
    expect(old.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(old.tracks[1].stop).toHaveBeenCalledTimes(1)
    expect(peekLive()).toBe(next)
    expect(getUserMediaCalls()).toBe(2)
  })

  it('acquires again when the stream has no track', async () => {
    await acquireWith(0, makeFakeStream([]))
    expect(peekLive()).toBeNull()
    const next = makeFakeStream()
    expect(await acquireWith(1, next)).toBe(next)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('calls getUserMedia only once for concurrent acquire()', async () => {
    const first = acquire()
    const second = acquire()
    expect(second).toBe(first)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const stream = makeFakeStream()
    await gum.calls[0].resolve(stream)
    expect(await first).toBe(stream)
    expect(await second).toBe(stream)
  })

  it('throws the failure and clears pending', async () => {
    const promise = acquire()
    const error = new DOMException('denied', 'NotAllowedError')
    const rejected = expect(promise).rejects.toBe(error)
    await gum.calls[0].reject(error)
    await rejected
    expect(peekLive()).toBeNull()
    // pending が空に戻ったので、次の acquire() は getUserMedia を呼び直す
    const stream = makeFakeStream()
    expect(await acquireWith(1, stream)).toBe(stream)
    expect(gum.getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('adds the ended listener only once to a track for 10 recordings, and once again to a new track', async () => {
    const stream = makeFakeStream()
    const [spy] = spyListeners(stream)
    await acquireWith(0, stream)
    for (let i = 0; i < 10; i++) expect(peekLive()).toBe(stream)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('ended', expect.any(Function))

    endTrack(stream.tracks[0])
    const next = makeFakeStream()
    const [nextSpy] = spyListeners(next)
    await acquireWith(1, next)
    for (let i = 0; i < 10; i++) expect(peekLive()).toBe(next)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(nextSpy).toHaveBeenCalledTimes(1)
    expect(nextSpy).toHaveBeenCalledWith('ended', expect.any(Function))
  })

  it('records ended in endedEvents without stopping the track', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const stream = makeFakeStream([{}, {}])
    await acquireWith(0, stream)
    endTrack(stream.tracks[1])
    expect(endedEvents()).toEqual([{ at: 1234, track: 1 }])
    expect(stream.tracks[1].stop).not.toHaveBeenCalled()
  })

  it('keeps the last 20 ended events', async () => {
    const stream = makeFakeStream()
    await acquireWith(0, stream)
    for (let i = 0; i < 25; i++) endTrack(stream.tracks[0])
    expect(endedEvents()).toHaveLength(20)
  })

  it('empties the held stream, pending, the count, and the records with resetKeptMicForTest() without stopping the track', async () => {
    const stream = makeFakeStream()
    await acquireWith(0, stream)
    endTrack(stream.tracks[0])
    void acquire()
    resetKeptMicForTest()
    expect(peekLive()).toBeNull()
    expect(getUserMediaCalls()).toBe(0)
    expect(endedEvents()).toEqual([])
    // pending も空なので、次の acquire() は getUserMedia を呼ぶ
    void acquire()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(3)
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1)
  })
})
