import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import LegacyInterpreterPage from './LegacyInterpreterPage'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import { getLocalizedMessage } from '../messages'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream, FakeTrack } from '../test/audioMocks'

// 4回目の実験の legacymute（legacykeep に、録音の後の track の無効と、次の録音の開始での有効を加えたもの。
// docs/testing.md の「実験のスイッチ」）

const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let contexts: ReturnType<typeof setupAudioContext>

interface FakeAudio {
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  onerror: (() => void) | null
}
let audios: FakeAudio[]
let ttsFails: boolean

function setupAudio() {
  audios = []
  Object.defineProperty(globalThis, 'Audio', {
    value: vi.fn(function () {
      const audio: FakeAudio = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), onended: null, onerror: null }
      audios.push(audio)
      return audio
    }),
    writable: true,
    configurable: true,
  })
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:fake')
  globalThis.URL.revokeObjectURL = vi.fn()
}

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  contexts = setupAudioContext()
  setupAnimationFrame()
  setupAudio()
  ttsFails = false
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (input === '/api/tts') {
      if (ttsFails) return { ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response
      return { ok: true, status: 200, blob: () => Promise.resolve(new Blob(['mp3'])) } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
    } as unknown as Response
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

const muteConfig = () => readExperimentConfig('?exp=legacymute')

function renderLegacy(experiment?: ExperimentConfig) {
  return render(<LegacyInterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
}

const flag = () => screen.getByRole('button', { name: 'Japaneseで話す' })
const stopFlag = () => screen.getByRole('button', { name: 'Japaneseの録音を停止' })

// 録音を1回する。stream を渡したときは、getUserMedia の待ちを、その stream で解く（使い回すときは渡さない）
async function recordOnce(index: number, chunks: string[], options: { stream?: FakeStream; beforeOnstop?: () => void } = {}) {
  await act(async () => { fireEvent.click(flag()) })
  if (options.stream) {
    const pending = gum.calls[gum.calls.length - 1]
    await act(async () => { await pending.resolve(options.stream) })
  }
  const recorder = recorders.instances[index]
  await act(async () => { fireEvent.click(stopFlag()) })
  options.beforeOnstop?.()
  await act(async () => {
    chunks.forEach(c => recorder.ondataavailable?.({ data: new Blob([c]) }))
    recorder.onstop?.()
  })
  await act(async () => { await Promise.resolve() })
}

// 読み上げを1回する。end は、再生の後に起こす出来事
async function speakOnce(end: 'ended' | 'error' | 'none' = 'ended') {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
  const audio = audios[audios.length - 1]
  if (end === 'ended') await act(async () => { audio.onended?.() })
  if (end === 'error') await act(async () => { audio.onerror?.() })
  return audio
}

async function copyJson() {
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { copied = text }) }, configurable: true })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return JSON.parse(copied)
}

// track の enabled の読み書きを残す（書き込みの順番と、MediaRecorder を作ったときの値を調べるため）
function watchEnabled(track: FakeTrack, log: string[]) {
  let value = track.enabled
  const get = vi.fn(() => value)
  const set = vi.fn((v: boolean) => { value = v; log.push(`enabled=${v}`) })
  Object.defineProperty(track, 'enabled', { get, set, configurable: true })
  return { get, set }
}

// MediaRecorder を作ったときの track の enabled を残す
function logRecorderCreation(track: FakeTrack, log: string[]) {
  const ctor = recorders.Ctor as unknown as { getMockImplementation: () => (...args: unknown[]) => unknown; mockImplementation: (f: (...args: unknown[]) => unknown) => void }
  const impl = ctor.getMockImplementation()
  ctor.mockImplementation(function (this: unknown, ...args: unknown[]) {
    log.push(`MediaRecorder(enabled=${track.enabled})`)
    return impl.apply(this, args)
  })
}

const interpretCalls = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, { body: FormData }][] } }).mock.calls.filter(c => c[0] === '/api/interpret')

// 次の録音を、音声認識の constructor の例外で失敗させる。始めた MediaRecorder を返す
async function failByRecognition() {
  ;(recognitions.Ctor as unknown as { mockImplementationOnce: (f: () => never) => void }).mockImplementationOnce(function () { throw new Error('unavailable') })
  await act(async () => { fireEvent.click(flag()) })
  return recorders.instances[recorders.instances.length - 1]
}

describe('LegacyInterpreterPage with exp=legacymute: track', () => {
  it('calls getUserMedia once and disables the track after onstop without stopping it', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['abc'], { stream })
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].enabled).toBe(false)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(document.querySelector('.translation-card__text')).toHaveTextContent('こんにちは')
  })

  it('keeps the track enabled when stopRecording calls MediaRecorder.stop()', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], {
      stream,
      beforeOnstop: () => {
        // 停止を押して MediaRecorder.stop() を呼んだ後、onstop の前
        expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
        expect(stream.tracks[0].enabled).toBe(true)
      },
    })
    expect(stream.tracks[0].enabled).toBe(false)
  })

  it('enables the reused track before creating the MediaRecorder on the second recording', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const log: string[] = []
    watchEnabled(stream.tracks[0], log)
    logRecorderCreation(stream.tracks[0], log)
    await recordOnce(1, ['b'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect((recorders.Ctor as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toBe(stream)
    expect(log).toEqual(['enabled=true', 'MediaRecorder(enabled=true)', 'enabled=false'])
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
  })

  it('starts the MediaRecorder, the AudioContext and the recognition inside the tap on the second recording', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    // await を挟まないので、国旗を押した処理の中（Promise を進める前）で始まっている
    act(() => { fireEvent.click(flag()) })
    expect(stream.tracks[0].enabled).toBe(true)
    expect(recorders.instances[1].start).toHaveBeenCalledTimes(1)
    expect(contexts.instances).toHaveLength(2)
    expect(recognitions.instances[1].start).toHaveBeenCalledTimes(1)
    const contextOrder = (contexts.Ctor as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
    expect(recorders.instances[1].start.mock.invocationCallOrder[0]).toBeLessThan(contextOrder[1])
    expect(contextOrder[1]).toBeLessThan(recognitions.instances[1].start.mock.invocationCallOrder[0])
    await act(async () => { await Promise.resolve() })
  })

  it('disables the track on an onstop that the user did not cause', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await act(async () => { fireEvent.click(flag()) })
    await act(async () => { await gum.calls[0].resolve(stream) })
    await act(async () => { recorders.instances[0].onstop?.() })
    expect(stream.tracks[0].enabled).toBe(false)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(c => c[0] === '/api/interpret')).toHaveLength(0)
  })

  it('disables the track again when the MediaRecorder constructor throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const log: string[] = []
    watchEnabled(stream.tracks[0], log)
    setupMediaRecorder({ throwOnCreate: true })
    await act(async () => { fireEvent.click(flag()) })
    expect(log).toEqual(['enabled=true', 'enabled=false'])
    expect(stream.tracks[0].enabled).toBe(false)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(getLocalizedMessage('microphone_denied', 'ja', 'en'))
  })

  it('disables the track again when MediaRecorder.start() throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const log: string[] = []
    watchEnabled(stream.tracks[0], log)
    const failing = setupMediaRecorder({ throwOnStart: true })
    await act(async () => { fireEvent.click(flag()) })
    expect(failing.instances).toHaveLength(1)
    expect(failing.instances[0].start).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['enabled=true', 'enabled=false'])
    expect(stream.tracks[0].enabled).toBe(false)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('stops the started MediaRecorder and cleans up when the recognition constructor throws (OO1, OO9)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const orphan = await failByRecognition()
    expect(warn).toHaveBeenCalled()
    // 始めた MediaRecorder を止める
    expect(orphan.start).toHaveBeenCalledTimes(1)
    expect(orphan.stop).toHaveBeenCalledTimes(1)
    expect(orphan.state).toBe('inactive')
    // 波紋と AudioContext を片付ける
    expect(contexts.instances[1].close).toHaveBeenCalledTimes(1)
    // track は無効になり、止めない
    expect(stream.tracks[0].enabled).toBe(false)
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    // 画面は idle に戻り、国旗を押せる
    expect(flag()).toBeEnabled()
    // 選んだ2つの言語（日本語と英語）の microphone_denied の文
    expect(screen.getByRole('alert').textContent).toBe(getLocalizedMessage('microphone_denied', 'ja', 'en'))
    // 止めた MediaRecorder の最後のデータと onstop が来ても、翻訳には送らない
    await act(async () => {
      orphan.ondataavailable?.({ data: new Blob(['old']) })
      orphan.onstop?.()
    })
    await act(async () => { await Promise.resolve() })
    expect(interpretCalls()).toHaveLength(1)
    // 止めた録音の記録には、onstop で無効にした track の状態が残る
    const json = await copyJson()
    expect(json.recordings[1].keepStream).toMatchObject({ recordingNo: 2, trackStatesAfterEnable: ['live/enabled/unmuted'], trackStatesAfterDisable: ['live/disabled/unmuted'] })
  })

  it('does not mix the stopped recorder data into the next recording (OO9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const orphan = await failByRecognition()
    // 次の録音を始めた後に、止めた MediaRecorder の最後のデータと onstop が遅れて来る
    await act(async () => { fireEvent.click(flag()) })
    expect(stream.tracks[0].enabled).toBe(true)
    await act(async () => {
      orphan.ondataavailable?.({ data: new Blob(['OLD']) })
      orphan.onstop?.()
    })
    // 次の録音の track は無効にしない
    expect(stream.tracks[0].enabled).toBe(true)
    const next = recorders.instances[2]
    await act(async () => { fireEvent.click(stopFlag()) })
    await act(async () => {
      next.ondataavailable?.({ data: new Blob(['new']) })
      next.onstop?.()
    })
    await act(async () => { await Promise.resolve() })
    const calls = interpretCalls()
    expect(calls).toHaveLength(2)
    const audio = calls[1][1].body.get('audio') as File
    expect(await audio.text()).toBe('new')
    expect(stream.tracks[0].enabled).toBe(false)
  })

  it('does not interpret the stopped recorder when the screen goes away (OO9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { unmount } = renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    const orphan = await failByRecognition()
    unmount()
    await act(async () => {
      orphan.ondataavailable?.({ data: new Blob(['old']) })
      orphan.onstop?.()
    })
    await act(async () => { await Promise.resolve() })
    expect(interpretCalls()).toHaveLength(1)
  })

  it('does not interpret the stopped recorder after the next recording was stopped and the screen goes away (OO9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { unmount } = renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    const orphan = await failByRecognition()
    // 次の録音を利用者が止めた後（userStoppedRef が true のまま）に画面を離れる
    await recordOnce(2, ['new'])
    expect(interpretCalls()).toHaveLength(2)
    unmount()
    await act(async () => {
      orphan.ondataavailable?.({ data: new Blob(['old']) })
      orphan.onstop?.()
    })
    await act(async () => { await Promise.resolve() })
    expect(interpretCalls()).toHaveLength(2)
  })

  it('does not call stop() when MediaRecorder.start() throws (OO9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    const failing = setupMediaRecorder({ throwOnStart: true })
    await act(async () => { fireEvent.click(flag()) })
    expect(failing.instances[0].state).toBe('inactive')
    expect(failing.instances[0].stop).not.toHaveBeenCalled()
    expect(stream.tracks[0].enabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe(getLocalizedMessage('microphone_denied', 'ja', 'en'))
  })

  it('stops the track when the screen goes away', async () => {
    const { unmount } = renderLegacy(muteConfig())
    const stream = makeFakeStream()
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    expect(stream.tracks[0].stop).not.toHaveBeenCalled()
    unmount()
    expect(stream.tracks[0].stop).toHaveBeenCalled()
  })

  it('reuses a disabled track without calling getUserMedia again', async () => {
    renderLegacy(muteConfig())
    const stream = makeFakeStream([{ enabled: false }])
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    await recordOnce(2, ['c'])
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    const json = await copyJson()
    expect(json.recordings.map((r: { keepStream: { streamReused: boolean } }) => r.keepStream.streamReused)).toEqual([false, true, true])
  })
})

describe('LegacyInterpreterPage with exp=legacymute: records', () => {
  it('records recordingNo and the track states after enable and disable', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await recordOnce(1, ['b'])
    await recordOnce(2, ['c'])
    const json = await copyJson()
    expect(json.effective).toEqual(['legacymute'])
    expect(json.recordings.map((r: { keepStream: unknown }) => r.keepStream)).toEqual([
      expect.objectContaining({ recordingNo: 1, streamReused: false, getUserMediaCalls: 1, trackStates: [], trackStatesAfterEnable: ['live/enabled/unmuted'], trackStatesAfterDisable: ['live/disabled/unmuted'] }),
      expect.objectContaining({ recordingNo: 2, streamReused: true, getUserMediaCalls: 1, trackStates: ['live/disabled/unmuted'], trackStatesAfterEnable: ['live/enabled/unmuted'], trackStatesAfterDisable: ['live/disabled/unmuted'] }),
      expect.objectContaining({ recordingNo: 3, streamReused: true, getUserMediaCalls: 1, trackStates: ['live/disabled/unmuted'], trackStatesAfterEnable: ['live/enabled/unmuted'], trackStatesAfterDisable: ['live/disabled/unmuted'] }),
    ])
  })

  it('keeps trackStatesAfterDisable empty until onstop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    // 2回目は開始の後に AudioContext より後の音声認識の作成で失敗する。止めた MediaRecorder の onstop は、テストが起こすまで来ない
    ;(recognitions.Ctor as unknown as { mockImplementationOnce: (f: () => never) => void }).mockImplementationOnce(function () { throw new Error('unavailable') })
    await act(async () => { fireEvent.click(flag()) })
    const json = await copyJson()
    expect(json.recordings[1].keepStream).toMatchObject({ recordingNo: 2, trackStatesAfterEnable: ['live/enabled/unmuted'], trackStatesAfterDisable: [] })
  })

  it('records the reading aloud with the track states before play', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await recordOnce(1, ['b'])
    await recordOnce(2, ['c'])
    const audio = await speakOnce('ended')
    expect(audio.play).toHaveBeenCalledTimes(1)
    const json = await copyJson()
    expect(json.ttsPlays).toEqual([
      { afterRecordingNo: 3, trackStatesBeforePlay: ['live/disabled/unmuted'], playCalledAt: expect.any(Number), playResult: 'resolved', ended: true, error: false },
    ])
  })

  it('records the exception name of play() and onerror', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    // 1件目：play() が例外
    const Audio = globalThis.Audio as unknown as { getMockImplementation: () => (...args: unknown[]) => FakeAudio; mockImplementationOnce: (f: (...args: unknown[]) => FakeAudio) => void }
    const impl = Audio.getMockImplementation()
    Audio.mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
      const audio = impl.apply(this, args)
      audio.play.mockRejectedValue(new DOMException('not allowed', 'NotAllowedError'))
      return audio
    })
    await speakOnce('none')
    // 2件目：onerror が来る
    await speakOnce('error')
    const json = await copyJson()
    expect(json.ttsPlays).toEqual([
      expect.objectContaining({ afterRecordingNo: 1, playResult: 'NotAllowedError', ended: false, error: false }),
      expect.objectContaining({ afterRecordingNo: 1, playResult: 'resolved', ended: false, error: true }),
    ])
  })

  it('records the type of a non-Error rejection of play()', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    const Audio = globalThis.Audio as unknown as { getMockImplementation: () => (...args: unknown[]) => FakeAudio; mockImplementationOnce: (f: (...args: unknown[]) => FakeAudio) => void }
    const impl = Audio.getMockImplementation()
    Audio.mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
      const audio = impl.apply(this, args)
      audio.play.mockRejectedValue('blocked')
      return audio
    })
    await speakOnce('none')
    const json = await copyJson()
    expect(json.ttsPlays[0].playResult).toBe('string')
  })

  it('records a muted track as muted', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream([{ muted: true }]) })
    await recordOnce(1, ['b'])
    const json = await copyJson()
    expect(json.recordings[1].keepStream).toMatchObject({ trackStates: ['live/disabled/muted'], trackStatesAfterEnable: ['live/enabled/muted'], trackStatesAfterDisable: ['live/disabled/muted'] })
  })

  it('keeps the latest ten readings', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await speakOnce()
    await recordOnce(1, ['b'])
    for (let i = 0; i < 10; i++) await speakOnce()
    const json = await copyJson()
    expect(json.ttsPlays).toHaveLength(10)
    expect(json.ttsPlays.map((p: { afterRecordingNo: number }) => p.afterRecordingNo)).toEqual(Array(10).fill(2))
  })

  it('does not record the reading when play() is not called', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    ttsFails = true
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    expect(audios).toHaveLength(0)
    const json = await copyJson()
    expect(json.ttsPlays).toEqual([])
  })

  it('shows the values only when 更新 is pressed and copies the readings', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    const snapshot = screen.getByTestId('experiment-snapshot')
    expect(snapshot).toHaveTextContent('（legacymute）')
    expect(snapshot).toHaveTextContent('録音の番号=1、有効に戻した後の track=live/enabled/unmuted、無効にした後の track=live/disabled/unmuted')
    expect(screen.getByTestId('experiment-tts-plays')).toHaveTextContent('読み上げの記録はありません')
    await speakOnce()
    // 押すまでは変わらない
    expect(screen.getByTestId('experiment-tts-plays')).toHaveTextContent('読み上げの記録はありません')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-tts-plays')).toHaveTextContent('直前の録音の番号=1、再生の前の track=live/disabled/unmuted、play()=resolved、onended=来た、onerror=来ていない')
    const json = await copyJson()
    expect(json.ttsPlays).toHaveLength(1)
  })

  it('shows only the latest five readings', async () => {
    renderLegacy(muteConfig())
    await recordOnce(0, ['a'], { stream: makeFakeStream() })
    for (let i = 0; i < 7; i++) await speakOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-tts-plays').querySelectorAll('li')).toHaveLength(5)
    const json = await copyJson()
    expect(json.ttsPlays).toHaveLength(7)
  })
})

// legacymute を足しても、legacykeep、legacy、スイッチなしの動きは変わらない
describe('LegacyInterpreterPage without legacymute (unchanged)', () => {
  const KEEP_STREAM_KEYS = ['streamReused', 'getUserMediaCalls', 'trackStates', 'rmsMax', 'rmsNonZeroSamples', 'rmsSamples',
    'audioContextState', 'audioContextFirstTickState', 'audioContextError', 'transcriptSent']

  it('does not change enabled or record the reading with legacykeep', async () => {
    renderLegacy(readExperimentConfig('?exp=legacykeep'))
    const stream = makeFakeStream()
    const log: string[] = []
    const { set } = watchEnabled(stream.tracks[0], log)
    await recordOnce(0, ['a'], { stream })
    await recordOnce(1, ['b'])
    expect(stream.tracks[0].enabled).toBe(true)
    await speakOnce()
    expect(set).not.toHaveBeenCalled()
    const json = await copyJson()
    expect(json).not.toHaveProperty('ttsPlays')
    json.recordings.forEach((r: { keepStream: object }) => expect(Object.keys(r.keepStream).sort()).toEqual([...KEEP_STREAM_KEYS].sort()))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('（legacykeep）')
    expect(screen.getByTestId('experiment-snapshot')).not.toHaveTextContent('録音の番号')
    expect(screen.queryByTestId('experiment-tts-plays')).not.toBeInTheDocument()
  })

  it('does not read or change the track state or record the reading with legacy', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    const stream = makeFakeStream()
    const getters = (['readyState', 'muted'] as const).map(key => {
      const getter = vi.fn(() => (key === 'readyState' ? 'live' : false))
      Object.defineProperty(stream.tracks[0], key, { get: getter, configurable: true })
      return getter
    })
    const { get, set } = watchEnabled(stream.tracks[0], [])
    await recordOnce(0, ['a'], { stream })
    await speakOnce()
    expect(stream.tracks[0].stop).toHaveBeenCalled()
    getters.forEach(g => expect(g).not.toHaveBeenCalled())
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    const json = await copyJson()
    expect(json).not.toHaveProperty('ttsPlays')
    json.recordings.forEach((r: object) => expect(r).not.toHaveProperty('keepStream'))
  })

  it('leaves the MediaRecorder recording when the recognition constructor throws with legacykeep and legacy (OO9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const search of ['?exp=legacykeep', '?exp=legacy']) {
      const { unmount } = renderLegacy(readExperimentConfig(search))
      const before = recorders.instances.length
      await recordOnce(before, ['a'], { stream: makeFakeStream() })
      ;(recognitions.Ctor as unknown as { mockImplementationOnce: (f: () => never) => void }).mockImplementationOnce(function () { throw new Error('unavailable') })
      await act(async () => { fireEvent.click(flag()) })
      // legacy は録音のたびに getUserMedia を呼ぶ
      if (search === '?exp=legacy') await act(async () => { await gum.calls[gum.calls.length - 1].resolve(makeFakeStream()) })
      const started = recorders.instances[before + 1]
      expect(started.start).toHaveBeenCalledTimes(1)
      expect(started.stop).not.toHaveBeenCalled()
      expect(started.state).toBe('recording')
      expect(screen.getByRole('alert').textContent).toBe(getLocalizedMessage('microphone_denied', 'ja', 'en'))
      unmount()
    }
  })

  it('works as before without exp', async () => {
    renderLegacy()
    const stream = makeFakeStream()
    const { set } = watchEnabled(stream.tracks[0], [])
    await recordOnce(0, ['a'], { stream })
    const audio = await speakOnce()
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'コピー' })).not.toBeInTheDocument()
  })
})
