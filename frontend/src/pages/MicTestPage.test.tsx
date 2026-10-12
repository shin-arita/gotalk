import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import App from '../App'
import MicTestPage from './MicTestPage'

const DESCRIPTION =
  'マイク動作確認用の開発ページです。録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信・保存しません。音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。録音した音声は、このページの中で再生するためだけにメモリに持ちます。送信も保存もしません。次の録音を始めたとき、S6 を押したとき、ページを閉じたときに捨てます。「AudioContext で再生」は、<audio> とは別の方法（Web Audio API）で鳴らし、再生の後もマイクから音が取れるかを確かめるためのものです。試すときは、ページを読み込み直してから、「直前の録音を再生」を押さずに試してください。'

// --- getUserMedia mock ---

interface MockTrack {
  enabled: boolean
  readyState: string
  muted: boolean
  stop: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  listeners: Record<string, (() => void)[]>
}

let tracks: MockTrack[] = []

function makeTrack(): MockTrack {
  const track: MockTrack = {
    enabled: true,
    readyState: 'live',
    muted: false,
    // 実際のブラウザと同じく、stop() では ended のイベントを出さない
    stop: vi.fn(() => { track.readyState = 'ended' }),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      (track.listeners[type] ??= []).push(fn)
    }),
    listeners: {},
  }
  tracks.push(track)
  return track
}

// track に音が届かなくなったとき（mute）と、届くようになったとき（unmute）の動き
function setTrackMuted(track: MockTrack, muted: boolean) {
  track.muted = muted
  track.listeners[muted ? 'mute' : 'unmute']?.forEach(fn => fn())
}

// ブラウザや OS が track を終わらせたときの動き
function endTrack(track: MockTrack) {
  track.readyState = 'ended'
  track.listeners.ended?.forEach(fn => fn())
}

function setupGetUserMediaMock() {
  // 呼ばれるたびに新しい track を持つ stream を返す
  const getUserMedia = vi.fn(async () => {
    const track = makeTrack()
    return { getTracks: () => [track] }
  })
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
  return getUserMedia
}

// getUserMedia を待たせ、テストの中で成功させる
function setupDeferredGetUserMediaMock() {
  let resolve: () => void = () => {}
  const getUserMedia = vi.fn(() => new Promise(r => {
    resolve = () => {
      const track = makeTrack()
      r({ getTracks: () => [track] })
    }
  }))
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
  return { getUserMedia, resolve: () => resolve() }
}

// --- MediaRecorder mock ---

interface MockRecorder {
  state: string
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstart: ((e: Event) => void) | null
  onstop: ((e: Event) => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

let recorders: MockRecorder[] = []

// deferOnstop が true のときは、実際のブラウザと同じく stop() の後に onstop を出さず、
// テストの中で finishRecorder() を呼んで遅れて届かせる
function setupMediaRecorderMock(deferOnstop = false) {
  const Ctor = vi.fn(function () {
    const recorder: MockRecorder = {
      state: 'inactive',
      mimeType: '',
      ondataavailable: null,
      onstart: null,
      onstop: null,
      start: vi.fn(() => {
        recorder.state = 'recording'
        recorder.onstart?.(new Event('start'))
      }),
      stop: vi.fn(() => {
        recorder.state = 'inactive'
        if (!deferOnstop) finishRecorder(recorder)
      }),
    }
    recorders.push(recorder)
    return recorder
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
  Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
  Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
}

function finishRecorder(recorder: MockRecorder) {
  recorder.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) })
  recorder.onstop?.(new Event('stop'))
}

// MediaRecorder の作成（where = 'create'）か start()（where = 'start'）が例外になる
function setupFailingMediaRecorderMock(where: 'create' | 'start') {
  const Ctor = vi.fn(function () {
    if (where === 'create') throw new DOMException('not supported', 'NotSupportedError')
    const recorder = {
      state: 'inactive',
      mimeType: '',
      ondataavailable: null,
      onstop: null,
      start: vi.fn(() => { throw new DOMException('bad state', 'InvalidStateError') }),
      stop: vi.fn(),
    }
    recorders.push(recorder as unknown as MockRecorder)
    return recorder
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
  Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
  Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
}

// --- SpeechRecognition mock ---

interface MockRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: unknown) => void) | null
  onsoundstart: (() => void) | null
  onsoundend: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onnomatch: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

let recognitions: MockRecognition[] = []

function setupRecognitionMock(startThrows = false) {
  const Ctor = vi.fn(function () {
    const recognition: MockRecognition = {
      lang: '',
      continuous: false,
      interimResults: false,
      onresult: null,
      onsoundstart: null,
      onsoundend: null,
      onspeechstart: null,
      onspeechend: null,
      onnomatch: null,
      start: vi.fn(() => {
        if (startThrows) throw new DOMException('not allowed', 'NotAllowedError')
      }),
      stop: vi.fn(),
    }
    recognitions.push(recognition)
    return recognition
  })
  Object.defineProperty(window, 'SpeechRecognition', { value: Ctor, writable: true, configurable: true })
}

// 音声認識の作成が例外になる
function setupFailingRecognitionCtorMock() {
  const Ctor = vi.fn(function () { throw new DOMException('not allowed', 'NotAllowedError') })
  Object.defineProperty(window, 'SpeechRecognition', { value: Ctor, writable: true, configurable: true })
}

// --- AudioContext mock ---

interface MockSource {
  buffer: unknown
  onended: (() => void) | null
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface MockAudioContext {
  state: string
  sampleRate: number
  baseLatency?: number
  onstatechange: (() => void) | null
  destination: object
  resume: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  decodeAudioData: ReturnType<typeof vi.fn>
  createBufferSource: ReturnType<typeof vi.fn>
}

let audioContexts: MockAudioContext[] = []
let sources: MockSource[] = []

function setContextState(context: MockAudioContext, state: string) {
  context.state = state
  context.onstatechange?.()
}

interface AudioContextMockOptions {
  // 作ったときの state（iPhone などでは suspended になることがある）
  initialState?: string
  resumeFails?: boolean
  decodeFails?: boolean
  // decodeAudioData を待たせ、テストの中で resolveDecode() を呼んで成功させる
  deferDecode?: boolean
  // baseLatency がないブラウザ
  noBaseLatency?: boolean
}

function setupAudioContextMock(options: AudioContextMockOptions = {}) {
  const pendingDecodes: (() => void)[] = []
  const Ctor = vi.fn(function () {
    const context: MockAudioContext = {
      state: options.initialState ?? 'running',
      sampleRate: 48000,
      ...(options.noBaseLatency ? {} : { baseLatency: 0.005 }),
      onstatechange: null,
      destination: {},
      resume: vi.fn(async () => {
        if (options.resumeFails) throw new DOMException('not allowed', 'NotAllowedError')
        setContextState(context, 'running')
      }),
      close: vi.fn(async () => { setContextState(context, 'closed') }),
      decodeAudioData: vi.fn(() => {
        if (options.decodeFails) return Promise.reject(new DOMException('bad data', 'EncodingError'))
        const buffer = { duration: 1.5 }
        if (!options.deferDecode) return Promise.resolve(buffer)
        return new Promise(resolve => { pendingDecodes.push(() => resolve(buffer)) })
      }),
      createBufferSource: vi.fn(() => {
        const source: MockSource = {
          buffer: null,
          onended: null,
          connect: vi.fn(),
          start: vi.fn(),
          // 実際のブラウザと同じく、stop() の後にも onended が届く（テストの中で finishSource() で届かせる）
          stop: vi.fn(),
        }
        sources.push(source)
        return source
      }),
    }
    audioContexts.push(context)
    return context
  })
  Object.defineProperty(window, 'AudioContext', { value: Ctor, writable: true, configurable: true })
  return {
    Ctor,
    resolveDecode: async () => { await act(async () => { pendingDecodes.shift()?.() }) },
  }
}

function finishSource(source: MockSource) {
  act(() => { source.onended?.() })
}

// --- navigator.permissions mock ---

function setupPermissionsMock(rejects = false) {
  const query = rejects
    ? vi.fn().mockRejectedValue(new TypeError('unsupported'))
    : vi.fn().mockResolvedValue({ state: 'granted', addEventListener: vi.fn(), removeEventListener: vi.fn() })
  Object.defineProperty(globalThis.navigator, 'permissions', { value: { query }, writable: true, configurable: true })
  return query
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function renderPage() {
  await act(async () => { render(<MicTestPage />) })
}

// start の中の例外が未処理の Promise の拒否にならないことを確かめる
// テストは Node で動くので、Node の process の unhandledRejection を見る（アプリの型には Node の型がない）
type NodeProcess = { on(event: string, fn: (...args: unknown[]) => void): void; off(event: string, fn: (...args: unknown[]) => void): void }
const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process

function watchUnhandledRejections() {
  const handler = vi.fn()
  nodeProcess.on('unhandledRejection', handler)
  return {
    handler,
    async settle() {
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      nodeProcess.off('unhandledRejection', handler)
    },
  }
}

function logText() {
  return screen.getByTestId('mic-test-log').textContent ?? ''
}

// --- Lifecycle ---

type SavedProperty = { target: object; key: string; descriptor: PropertyDescriptor | undefined }
let savedProperties: SavedProperty[] = []

function saveProperty(target: object, key: string) {
  savedProperties.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
}

let fetchMock: ReturnType<typeof vi.fn>
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

// 再生の mock。play() を呼ぶと playing のイベントを出す
function setupPlayMock(rejects = false) {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    if (rejects) return Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  return { play, pause }
}

// play() の Promise を解決せずに待たせ、pause() で AbortError にして拒否する（Chrome などの動き）
function setupAbortOnPausePlayMock() {
  const rejects = new Map<HTMLMediaElement, (e: unknown) => void>()
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    return new Promise<void>((_, reject) => { rejects.set(this, reject) })
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    rejects.get(this)?.(new DOMException('interrupted by pause', 'AbortError'))
  })
  return { play, pause }
}

// play() の Promise を待たせ、pause() の後に拒否せずに解決する（拒否しないブラウザの動き）
function setupResolveAfterPausePlayMock() {
  const resolves = new Map<HTMLMediaElement, () => void>()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    return new Promise<void>(resolve => { resolves.set(this, resolve) })
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    resolves.get(this)?.()
  })
}

// play() の Promise を待たせ、テストの中で拒否する。pause() では何もしない
function setupControlledPlayMock() {
  const rejects = new Map<HTMLMediaElement, (e: unknown) => void>()
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    return new Promise<void>((_, reject) => { rejects.set(this, reject) })
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  return {
    play,
    reject: async (audio: HTMLMediaElement, name: string) => {
      await act(async () => { rejects.get(audio)?.(new DOMException('play failed', name)) })
    },
  }
}

// 再生の途中のメディアのエラー（code は MediaError の code）
function fireMediaError(audio: HTMLMediaElement, code?: number) {
  if (code !== undefined) Object.defineProperty(audio, 'error', { value: { code }, configurable: true })
  act(() => { audio.dispatchEvent(new Event('error')) })
}

function countMatches(text: string, re: RegExp) {
  return text.match(new RegExp(re.source, 'g'))?.length ?? 0
}

function playButton() {
  return screen.getByRole('button', { name: '直前の録音を再生' })
}

function contextPlayButton() {
  return screen.getByRole('button', { name: 'AudioContext で再生' })
}

// arrayBuffer() と decodeAudioData の Promise を待つ
async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function clickContextPlay() {
  await click('AudioContext で再生')
  await flush()
}

function recordingText() {
  return screen.getByTestId('mic-test-recording').textContent ?? ''
}

beforeEach(() => {
  savedProperties = []
  saveProperty(globalThis.navigator, 'mediaDevices')
  saveProperty(globalThis.navigator, 'permissions')
  saveProperty(URL, 'createObjectURL')
  saveProperty(URL, 'revokeObjectURL')
  let urlCount = 0
  createObjectURL = vi.fn(() => `blob:mock-${++urlCount}`)
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })
  tracks = []
  recorders = []
  recognitions = []
  audioContexts = []
  sources = []
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  setupGetUserMediaMock()
  setupMediaRecorderMock()
  setupPermissionsMock()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).MediaRecorder
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).AudioContext
  for (const { target, key, descriptor } of savedProperties) {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else delete (target as Record<string, unknown>)[key]
  }
  window.location.hash = ''
})

describe('MicTestPage', () => {
  it('#mic-test のときだけ表示し、通常の URL では表示しない', async () => {
    await act(async () => { render(<App />) })
    expect(screen.queryByText(DESCRIPTION)).not.toBeInTheDocument()
    cleanup()

    window.location.hash = '#mic-test'
    await act(async () => { render(<App />) })
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument()
  })

  it('上部の説明の文を表示する', async () => {
    await renderPage()
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument()
  })

  it('S1: 開始のたびに getUserMedia を呼び、停止で track を stop() する', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    await click('S1 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(recorders[0].start).toHaveBeenCalled()
    await click('S1 停止')
    expect(recorders[0].stop).toHaveBeenCalled()
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)

    await click('S1 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    await click('S1 停止')
    expect(tracks[1].stop).toHaveBeenCalledTimes(1)
    expect(logText()).toContain('MediaRecorder stop bytes=5')
    // GG5: S6 と同じように、track を閉じたことと、閉じる前の状態がログで分かる
    expect(logText()).toContain('track[0] readyState=live enabled=true muted=false（S1 停止、stop() の前）')
    expect(logText()).toContain('track を stop()（S1）')
    expect(logText()).toContain('track なし（S1 停止）')
  })

  it('S2: getUserMedia は最初の1回だけで、track.enabled を切り替え、track を stop() しない', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    await click('S2 開始')
    expect(tracks[0].enabled).toBe(true)
    await click('S2 停止')
    expect(tracks[0].enabled).toBe(false)
    await click('S2 開始')
    expect(tracks[0].enabled).toBe(true)
    await click('S2 停止')
    expect(tracks[0].enabled).toBe(false)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorders).toHaveLength(2)
    expect(tracks[0].stop).not.toHaveBeenCalled()
    expect(logText()).toContain('track[0] readyState=live enabled=false muted=false（S2 停止）')
  })

  it('GG1: track が ended になった後に S2 を始めると、古い track を stop() してマイクを開き直す', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    await click('S2 開始')
    await click('S2 停止')
    act(() => { endTrack(tracks[0]) })
    expect(logText()).toContain('track[0] ended（S2 1回目の開始の後）')

    await click('S2 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(tracks[1].enabled).toBe(true)
    expect(recorders).toHaveLength(2)
    const text = logText()
    const reopen = text.indexOf('track が終わっているため開き直す（readyState=ended）（S2）')
    const gum = text.indexOf('getUserMedia 開始（S2、開き直し）')
    expect(reopen).toBeGreaterThanOrEqual(0)
    // 新しいログが上なので、開き直しの行の直後（上）に getUserMedia の開始の行が続く
    expect(gum).toBeGreaterThanOrEqual(0)
    expect(gum).toBeLessThan(reopen)
  })

  it('GG1: track が ended になった後に S3 を始めても、マイクを開き直す', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S3 開始')
    act(() => { endTrack(tracks[0]) })
    expect(logText()).toContain('track[0] ended（S3 1回目の開始の後）')
    await click('S3 停止')
    await click('S3 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(logText()).toContain('track[0] readyState=live enabled=true muted=false（S3 開始）')
  })

  it('GG2: S1 で MediaRecorder の作成が例外になると、ログに出し、開いた track を閉じ、未処理の拒否にしない', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupFailingMediaRecorderMock('create')
    const rejections = watchUnhandledRejections()
    await renderPage()

    await click('S1 開始')
    expect(logText()).toContain('MediaRecorder 失敗 name=NotSupportedError')
    // GG6: 閉じられていない本当の失敗は、これまでどおり開始の失敗として扱う
    expect(logText()).toContain('S1 開始に失敗したため、すべて閉じる')
    expect(logText()).not.toContain('開始をやめる')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'S1 開始' })).toBeInTheDocument()

    // もう一度始めても、前の track は残らない
    await click('S1 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(tracks[1].stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'S1 開始' })).toBeInTheDocument()

    await rejections.settle()
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('GG2: S2 で MediaRecorder の start() が例外になると、すべて閉じて開始しない', async () => {
    setupGetUserMediaMock()
    setupFailingMediaRecorderMock('start')
    const rejections = watchUnhandledRejections()
    await renderPage()

    await click('S2 開始')
    expect(logText()).toContain('MediaRecorder 失敗 name=InvalidStateError')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'S2 開始' })).toBeInTheDocument()

    await rejections.settle()
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('GG2: S5 で音声認識の start() が例外になると、録音とマイクも閉じて開始しない', async () => {
    setupGetUserMediaMock()
    setupRecognitionMock(true)
    const rejections = watchUnhandledRejections()
    await renderPage()

    await click('S5 開始')
    expect(logText()).toContain('音声認識 start() 失敗 name=NotAllowedError')
    expect(recorders[0].stop).toHaveBeenCalled()
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    // 始められなかった音声認識の stop() は呼ばない
    expect(recognitions[0].stop).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'S5 開始' })).toBeInTheDocument()

    await rejections.settle()
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('track の mute と unmute を、テストの番号と開始の回数を入れてログに出す', async () => {
    setupRecognitionMock()
    await renderPage()

    await click('S3 開始')
    await click('S3 停止')
    await click('S3 開始')
    act(() => { setTrackMuted(tracks[0], true) })
    expect(logText()).toContain('track[0] mute（S3 2回目の開始の後）')
    await click('S3 停止')
    expect(logText()).toContain('track[0] readyState=live enabled=true muted=true（S3 停止）')
    act(() => { setTrackMuted(tracks[0], false) })
    expect(logText()).toContain('track[0] unmute（S3 2回目の開始の後）')
  })

  it('track の状態のログに muted を出す', async () => {
    await renderPage()
    await click('S2 開始')
    expect(logText()).toContain('track[0] readyState=live enabled=true muted=false（S2 開始）')
  })

  it('音声認識の onsoundstart、onsoundend、onspeechstart、onspeechend、onnomatch をログに出す', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S4 開始')

    const events = ['onsoundstart', 'onspeechstart', 'onspeechend', 'onsoundend', 'onnomatch'] as const
    act(() => { events.forEach(name => recognitions[0][name]?.()) })
    for (const name of events) {
      expect(logText()).toContain(`音声認識 ${name}`)
    }
  })

  it('GG3: S3: getUserMedia は最初の1回だけで、enabled は true のまま、録音せず、停止で track を閉じない', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S3 開始')
    expect(recognitions[0].start).toHaveBeenCalledTimes(1)
    await click('S3 停止')
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)
    await click('S3 開始')
    await click('S3 停止')

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(recognitions).toHaveLength(2)
    expect(recognitions[1].stop).toHaveBeenCalledTimes(1)
    expect(tracks[0].enabled).toBe(true)
    expect(tracks[0].stop).not.toHaveBeenCalled()
    expect(MediaRecorder).not.toHaveBeenCalled()
  })

  it('GG3: S5: getUserMedia は最初の1回だけで、enabled を切り替え、録音と音声認識を始めて止める', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S5 開始')
    expect(tracks[0].enabled).toBe(true)
    expect(recorders[0].start).toHaveBeenCalled()
    expect(recognitions[0].start).toHaveBeenCalledTimes(1)
    await click('S5 停止')
    expect(tracks[0].enabled).toBe(false)
    expect(recorders[0].stop).toHaveBeenCalled()
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)

    await click('S5 開始')
    expect(tracks[0].enabled).toBe(true)
    await click('S5 停止')
    expect(tracks[0].enabled).toBe(false)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorders).toHaveLength(2)
    expect(recognitions).toHaveLength(2)
    expect(tracks[0].stop).not.toHaveBeenCalled()
  })

  it('GG3: getUserMedia を待っている間に pagehide で閉じたら、後から成功した track を stop() する', async () => {
    const gum = setupDeferredGetUserMediaMock()
    await renderPage()

    await click('S2 開始')
    // 待っている間は、ほかのボタン（S6 を含む）を押せない
    expect(screen.getByRole('button', { name: 'S6 すべて閉じる' })).toBeDisabled()
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    await act(async () => { gum.resolve() })

    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(logText()).toContain('getUserMedia 成功したが、閉じた後のため track を stop()（S2）')
    expect(MediaRecorder).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'S2 開始' })).toBeEnabled()
  })

  it('GG3: getUserMedia を待っている間にコンポーネントが外れたら、後から成功した track を stop() する', async () => {
    const gum = setupDeferredGetUserMediaMock()
    const consoleError = vi.spyOn(console, 'error')
    const rejections = watchUnhandledRejections()
    const { unmount } = render(<MicTestPage />)
    await click('S7 開始')
    unmount()
    await act(async () => { gum.resolve() })

    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(MediaRecorder).not.toHaveBeenCalled()
    // 外れた後も、React の警告や例外、未処理の拒否が出ない
    await rejections.settle()
    expect(rejections.handler).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  // GG6: 待っている間に閉じられたときは、開始の失敗と区別して「開始をやめる」と出し、closeAll を重ねて呼ばない
  for (const id of ['S2', 'S1'] as const) {
    it(`GG6: ${id} の getUserMedia を待っている間に pagehide が起きたら、開始の失敗ではなく開始をやめたとログに出す`, async () => {
      const gum = setupDeferredGetUserMediaMock()
      const rejections = watchUnhandledRejections()
      await renderPage()

      await click(`${id} 開始`)
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      await act(async () => { gum.resolve() })

      expect(tracks[0].stop).toHaveBeenCalledTimes(1)
      const text = logText()
      expect(text).toContain(`${id} の開始をやめる（開始を待っている間に閉じられたため）`)
      expect(text).not.toContain('開始に失敗したため、すべて閉じる')
      expect(text).not.toContain('開始に失敗）')
      // closeAll は pagehide の1回だけ
      expect(text.match(/すべて閉じる/g)).toHaveLength(1)
      expect(MediaRecorder).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: `${id} 開始` })).toBeEnabled()

      await rejections.settle()
      expect(rejections.handler).not.toHaveBeenCalled()
    })
  }

  it('GG6: 別のテストからの切り替えでは「開始をやめる」と出さず、新しいテストが始まる', async () => {
    setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S2 開始')
    await click('S2 停止')
    await click('S3 開始')

    const text = logText()
    expect(text).toContain('前のテストを閉じます')
    expect(text).not.toContain('開始をやめる')
    expect(text).not.toContain('開始に失敗')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions[0].start).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'S3 停止' })).toBeInTheDocument()
  })

  it('GG6: 動いているテストから切り替えて開くときも「開始をやめる」と出さない', async () => {
    setupGetUserMediaMock()
    await renderPage()

    await click('S7 開始')
    await click('S1 開始')

    expect(logText()).not.toContain('開始をやめる')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders[1].start).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'S1 停止' })).toBeInTheDocument()
  })

  it('GG3: 音声認識が動いている S4 から別のテストに切り替えると、音声認識を stop() する', async () => {
    setupRecognitionMock()
    await renderPage()

    await click('S4 開始')
    await click('S3 開始')
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions[1].start).toHaveBeenCalledTimes(1)

    await click('S7 開始')
    expect(recognitions[1].stop).toHaveBeenCalledTimes(1)
  })

  it('S7: getUserMedia は最初の1回だけで、track.enabled は true のまま', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    await click('S7 開始')
    await click('S7 停止')
    expect(tracks[0].enabled).toBe(true)
    await click('S7 開始')
    expect(tracks[0].enabled).toBe(true)
    await click('S7 停止')

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(tracks[0].enabled).toBe(true)
    expect(tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders).toHaveLength(2)
  })

  it('S4: getUserMedia を呼ばずに、音声認識の start() と stop() を呼ぶ', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S4 開始')
    expect(recognitions[0].start).toHaveBeenCalledTimes(1)
    expect(recognitions[0].lang).toBe('ja-JP')
    expect(recognitions[0].continuous).toBe(true)
    expect(recognitions[0].interimResults).toBe(true)
    await click('S4 停止')
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)

    // 開始のたびに新しく作る
    await click('S4 開始')
    expect(recognitions).toHaveLength(2)
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(MediaRecorder).not.toHaveBeenCalled()
  })

  it('音声認識がないブラウザでは、S3、S4、S5 で対応していないとログに出す', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    for (const id of ['S3', 'S4', 'S5']) {
      await click(`${id} 開始`)
    }
    expect(logText().match(/このブラウザは音声認識に対応していません/g)).toHaveLength(3)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('S6: すべての track の stop() と音声認識の stop() を呼び、その後の S2 でマイクを開き直す', async () => {
    const getUserMedia = setupGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S5 開始')
    await click('S6 すべて閉じる')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders[0].stop).toHaveBeenCalled()

    await click('S2 開始')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('別のテストを始めるときは、前のテストのマイクを閉じる', async () => {
    const getUserMedia = setupGetUserMediaMock()
    await renderPage()

    await click('S2 開始')
    await click('S2 停止')
    await click('S7 開始')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('navigator.permissions.query が例外になる場合は unsupported と表示する', async () => {
    setupPermissionsMock(true)
    await renderPage()
    expect(logText()).toContain('permissions microphone=unsupported（ページを開いたとき）')

    await click('S7 開始')
    expect(logText()).toContain('permissions microphone=unsupported（S7 開始）')
  })

  it('permissions の状態を開始と停止のたびに表示する', async () => {
    await renderPage()
    await click('S7 開始')
    await click('S7 停止')
    expect(logText()).toContain('permissions microphone=granted（S7 開始）')
    expect(logText()).toContain('permissions microphone=granted（S7 停止）')
  })

  it('Backend への fetch を呼ばない', async () => {
    setupRecognitionMock()
    await renderPage()
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S7']) {
      await click(`${id} 開始`)
      await click(`${id} 停止`)
    }
    await click('S6 すべて閉じる')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('音声認識の結果の文字列は表示せず、文字数だけを表示する', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S4 開始')

    act(() => {
      recognitions[0].onresult?.({ results: { length: 2, 0: { 0: { transcript: 'ひみつの' } }, 1: { 0: { transcript: '言葉' } } } })
    })
    expect(logText()).toContain('音声認識 onresult 文字数=6')
    expect(document.body.textContent).not.toContain('ひみつ')
    expect(document.body.textContent).not.toContain('言葉')
  })

  it('pagehide と unmount で、マイク、録音、音声認識を閉じる', async () => {
    setupRecognitionMock()
    const { unmount } = render(<MicTestPage />)
    await click('S5 開始')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(recognitions[0].stop).toHaveBeenCalledTimes(1)
    expect(recorders[0].stop).toHaveBeenCalled()

    await click('S5 開始')
    unmount()
    expect(tracks[1].stop).toHaveBeenCalledTimes(1)
    expect(recognitions[1].stop).toHaveBeenCalledTimes(1)
  })

  it('録音していないときは、直前の録音を再生のボタンを押せない', async () => {
    setupRecognitionMock()
    await renderPage()
    expect(playButton()).toBeDisabled()

    // 録音しないテスト（S3、S4）だけを試した後も押せない
    for (const id of ['S3', 'S4']) {
      await click(`${id} 開始`)
      await click(`${id} 停止`)
    }
    expect(playButton()).toBeDisabled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('S2 で録音して停止すると再生のボタンを押せるようになり、テストの番号、回数、バイト数を表示する', async () => {
    await renderPage()
    await click('S2 開始')
    // 録音している間は、まだ押せない
    expect(playButton()).toBeDisabled()
    await click('S2 停止')

    expect(playButton()).toBeEnabled()
    expect(recordingText()).toMatch(/^S2 1回目の録音、5バイト、約\d+\.\d秒$/)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.size).toBe(5)
    expect(logText()).toContain('直前の録音を持つ（S2 1回目の録音、5バイト、')
  })

  for (const id of ['S1', 'S5', 'S7'] as const) {
    it(`${id} で録音して停止しても、再生のボタンを押せるようになる`, async () => {
      setupRecognitionMock()
      await renderPage()
      await click(`${id} 開始`)
      await click(`${id} 停止`)
      expect(playButton()).toBeEnabled()
      expect(recordingText()).toContain(`${id} 1回目の録音、5バイト`)
    })
  }

  it('次の録音を始めると、直前の録音を捨てて URL.revokeObjectURL を呼ぶ', async () => {
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await click('S2 開始')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(playButton()).toBeDisabled()
    expect(logText()).toContain('直前の録音を捨てる（次の録音の開始）')

    await click('S2 停止')
    expect(recordingText()).toContain('S2 2回目の録音')
  })

  it('録音しないテストに切り替えても、直前の録音は捨てない', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('S3 開始')
    await click('S3 停止')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(playButton()).toBeEnabled()
  })

  it('S6 で直前の録音を捨てて URL.revokeObjectURL を呼ぶ', async () => {
    await renderPage()
    await click('S7 開始')
    await click('S7 停止')
    await click('S6 すべて閉じる')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(playButton()).toBeDisabled()
    expect(logText()).toContain('直前の録音を捨てる（S6）')
  })

  it('録音している間に S6 を押すと、止めた録音を持たない', async () => {
    await renderPage()
    setupMediaRecorderMock(true)
    await click('S2 開始')
    await click('S6 すべて閉じる')
    act(() => { finishRecorder(recorders[0]) })
    expect(logText()).toContain('MediaRecorder stop bytes=5')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(playButton()).toBeDisabled()
  })

  it('pagehide で直前の録音を捨てて URL.revokeObjectURL を呼ぶ', async () => {
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(playButton()).toBeDisabled()
    expect(logText()).toContain('直前の録音を捨てる（pagehide）')
  })

  it('コンポーネントが外れたときに直前の録音を捨てて URL.revokeObjectURL を呼ぶ', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const { unmount } = render(<MicTestPage />)
    await click('S2 開始')
    await click('S2 停止')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('再生の開始と終わり、その前後の track の状態をログに出し、fetch も localStorage も使わない', async () => {
    const { play } = setupPlayMock()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')

    expect(play).toHaveBeenCalledTimes(1)
    const audio = play.mock.contexts[0] as HTMLAudioElement
    expect(audio.src).toBe('blob:mock-1')
    act(() => { audio.dispatchEvent(new Event('ended')) })

    const text = logText()
    expect(text).toContain('track[0] readyState=live enabled=false muted=false（再生の前）')
    expect(text).toMatch(/再生の開始（S2 1回目の録音、5バイト、/)
    expect(text).toMatch(/再生の終わり（S2 1回目の録音、5バイト、/)
    expect(text).toContain('track[0] readyState=live enabled=false muted=false（再生の終わり）')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('再生に失敗したら、name と track の状態をログに出す', async () => {
    setupPlayMock(true)
    const rejections = watchUnhandledRejections()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')

    expect(logText()).toMatch(/再生の失敗 name=NotAllowedError（S2 1回目の録音/)
    expect(logText()).toContain('track[0] readyState=live enabled=false muted=false（再生の失敗）')
    await rejections.settle()
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('再生している間に次の録音を始めると、再生を止める', async () => {
    const { pause } = setupPlayMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
    await click('S2 開始')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  // HH1: 開始に失敗した S5 の録音は、直前の録音として持たない
  for (const failure of ['start', 'create'] as const) {
    for (const defer of [false, true]) {
      it(`HH1: S5 で音声認識の${failure === 'start' ? 'start()' : '作成'}が失敗したら、その録音を持たない（onstop が${defer ? '遅れて' : 'すぐに'}届く場合）`, async () => {
        setupMediaRecorderMock(defer)
        if (failure === 'start') setupRecognitionMock(true)
        else setupFailingRecognitionCtorMock()
        await renderPage()

        await click('S5 開始')
        expect(logText()).toContain('S5 開始に失敗したため、すべて閉じる')
        expect(recorders[0].stop).toHaveBeenCalled()
        if (defer) act(() => { finishRecorder(recorders[0]) })

        expect(logText()).toContain('MediaRecorder stop bytes=5')
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(logText()).not.toContain('直前の録音を持つ')
        expect(playButton()).toBeDisabled()
      })
    }
  }

  it('HH1: 開始に失敗した S5 の前に持っていた直前の録音は、次の録音の開始として捨てる', async () => {
    setupRecognitionMock(true)
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    expect(playButton()).toBeEnabled()

    await click('S5 開始')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(logText()).toContain('直前の録音を捨てる（次の録音の開始）')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(playButton()).toBeDisabled()
  })

  it('HH1: 録音を始める前に失敗した開始では、切り替えで止めた前のテストの録音を無効にしない', async () => {
    setupMediaRecorderMock(true)
    await renderPage()
    await click('S2 開始')
    // 次の getUserMedia は失敗する
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
    await click('S7 開始')
    expect(logText()).toContain('S7 開始に失敗したため、すべて閉じる')

    act(() => { finishRecorder(recorders[0]) })
    expect(recordingText()).toContain('S2 1回目の録音、5バイト')
    expect(playButton()).toBeEnabled()
  })

  it('HH1: S5 の getUserMedia を待っている間に pagehide で閉じた場合も、録音を持たない', async () => {
    const gum = setupDeferredGetUserMediaMock()
    setupRecognitionMock()
    await renderPage()

    await click('S5 開始')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    await act(async () => { gum.resolve() })

    expect(logText()).toContain('S5 の開始をやめる（開始を待っている間に閉じられたため）')
    expect(MediaRecorder).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(playButton()).toBeDisabled()
  })

  it('HH2: テストが動いている間は再生のボタンを押せず、止めると押せるようになる', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S5 開始')
    await click('S5 停止')
    expect(playButton()).toBeEnabled()
    expect(screen.queryByTestId('mic-test-play-blocked')).not.toBeInTheDocument()

    await click('S3 開始')
    expect(playButton()).toBeDisabled()
    expect(screen.getByTestId('mic-test-play-blocked')).toHaveTextContent('（テストを止めてから再生できます）')
    // 録音は捨てていない
    expect(recordingText()).toContain('S5 1回目の録音')

    await click('S3 停止')
    expect(playButton()).toBeEnabled()
    expect(screen.queryByTestId('mic-test-play-blocked')).not.toBeInTheDocument()
  })

  it('HH2: getUserMedia を待っている間は再生のボタンを押せない', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    expect(playButton()).toBeEnabled()

    // S3 に切り替えると S2 のマイクを閉じて開き直すので、その getUserMedia を待たせる
    const gum = setupDeferredGetUserMediaMock()
    await click('S3 開始')
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(playButton()).toBeDisabled()
    expect(screen.getByTestId('mic-test-play-blocked')).toBeInTheDocument()

    await act(async () => { gum.resolve() })
    await click('S3 停止')
    expect(playButton()).toBeEnabled()
  })

  it('HH3: GG1 で開き直した track の mute を、テストの番号と正しい開始の回数でログに出す', async () => {
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    act(() => { endTrack(tracks[0]) })
    await click('S2 開始')
    expect(tracks).toHaveLength(2)

    act(() => { setTrackMuted(tracks[1], true) })
    expect(logText()).toContain('track[0] mute（S2 2回目の開始の後）')
    await click('S2 停止')
    await click('S2 開始')
    act(() => { setTrackMuted(tracks[1], false) })
    expect(logText()).toContain('track[0] unmute（S2 3回目の開始の後）')
  })

  it('HH3: S6 の後に開き直した track でも、mute と unmute をログに出す', async () => {
    await renderPage()
    await click('S7 開始')
    await click('S6 すべて閉じる')
    await click('S7 開始')
    expect(tracks).toHaveLength(2)

    act(() => { setTrackMuted(tracks[1], true) })
    expect(logText()).toContain('track[0] mute（S7 2回目の開始の後）')
    act(() => { setTrackMuted(tracks[1], false) })
    expect(logText()).toContain('track[0] unmute（S7 2回目の開始の後）')
  })

  it('HH3: 2回目の開始で作った音声認識の onsoundstart と onspeechstart をログに出す', async () => {
    setupRecognitionMock()
    await renderPage()
    await click('S3 開始')
    await click('S3 停止')
    await click('S3 開始')
    expect(recognitions).toHaveLength(2)
    expect(logText()).not.toContain('onsoundstart')

    act(() => {
      recognitions[1].onsoundstart?.()
      recognitions[1].onspeechstart?.()
    })
    expect(logText()).toContain('音声認識 onsoundstart')
    expect(logText()).toContain('音声認識 onspeechstart')
  })

  for (const how of ['next', 'S6'] as const) {
    it(`HH5: 再生の開始を待っている間に${how === 'next' ? '次の録音を始める' : 'S6 を押す'}と、再生の失敗ではなく再生を止めたとログに出す`, async () => {
      const rejections = watchUnhandledRejections()
      setupAbortOnPausePlayMock()
      await renderPage()
      await click('S2 開始')
      await click('S2 停止')
      await click('直前の録音を再生')

      await click(how === 'next' ? 'S2 開始' : 'S6 すべて閉じる')
      await rejections.settle()

      const text = logText()
      expect(text).toMatch(/再生を止めた（録音を捨てたため）（S2 1回目の録音、5バイト.*）name=AbortError/)
      // HH6: 止めたタイミングにかかわらず1回だけ
      expect(countMatches(text, /再生を止めた（/)).toBe(1)
      expect(countMatches(text, /（再生を止めた）/)).toBe(1)
      expect(text).not.toContain('再生の失敗')
      expect(rejections.handler).not.toHaveBeenCalled()
    })
  }

  it('HH5: 再生の開始を待っている間にもう一度再生すると、前の再生を止めたとログに出す', async () => {
    setupAbortOnPausePlayMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
    await click('直前の録音を再生')

    expect(logText()).toMatch(/再生を止めた（もう一度再生したため）（S2 1回目の録音/)
    expect(countMatches(logText(), /再生を止めた（/)).toBe(1)
    expect(logText()).not.toContain('再生の失敗')
  })

  it('HH5: 捨てていない Audio の本当の失敗は、これまでどおり再生の失敗と出す', async () => {
    setupPlayMock(true)
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')

    expect(logText()).toMatch(/再生の失敗 name=NotAllowedError（S2 1回目の録音/)
    expect(logText()).not.toContain('再生を止めた')
  })

  // HH6: 再生が始まった後に止めた場合も、「再生を止めた」と track の状態を1回だけ出す
  const stopWays = [
    { name: '次の録音の開始', reason: '録音を捨てたため', act: () => click('S2 開始') },
    { name: 'S6', reason: '録音を捨てたため', act: () => click('S6 すべて閉じる') },
    { name: 'pagehide', reason: '録音を捨てたため', act: async () => { act(() => { window.dispatchEvent(new Event('pagehide')) }) } },
    { name: 'もう一度再生', reason: 'もう一度再生したため', act: () => click('直前の録音を再生') },
  ]
  for (const way of stopWays) {
    it(`HH6: 再生が始まった後に${way.name}で止めると、「再生を止めた（${way.reason}）」と track の状態を1回だけ出す`, async () => {
      const rejections = watchUnhandledRejections()
      const { pause } = setupPlayMock()
      await renderPage()
      await click('S2 開始')
      await click('S2 停止')
      await click('直前の録音を再生')
      expect(logText()).toContain('再生の開始（S2 1回目の録音')

      await way.act()
      await rejections.settle()

      const text = logText()
      expect(pause).toHaveBeenCalledTimes(1)
      expect(countMatches(text, /再生を止めた（/)).toBe(1)
      expect(text).toMatch(new RegExp(`再生を止めた（${way.reason}）（S2 1回目の録音、5バイト[^）]*）`))
      expect(text).not.toMatch(/再生を止めた（[^）]*）（[^）]*）name=/)
      // 止めた後の track の状態（S6 と pagehide では track を閉じた後なので「track なし」）
      expect(countMatches(text, /（再生を止めた）/)).toBe(1)
      expect(text).not.toContain('再生の失敗')
      expect(rejections.handler).not.toHaveBeenCalled()
    })
  }

  it('HH6: 再生の開始を待っている間に止め、play() が拒否されずに解決した場合も、「再生を止めた」を1回だけ出す', async () => {
    const rejections = watchUnhandledRejections()
    setupResolveAfterPausePlayMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
    await click('S6 すべて閉じる')
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生を止めた（/)).toBe(1)
    expect(text).toMatch(/再生を止めた（録音を捨てたため）（S2 1回目の録音/)
    expect(text).toContain('track なし（再生を止めた）')
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH6: 再生が終わった後に録音を捨てても、「再生を止めた」を出さない', async () => {
    const rejections = watchUnhandledRejections()
    const { play } = setupPlayMock()
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
    const audio = play.mock.contexts[0] as HTMLAudioElement
    act(() => { audio.dispatchEvent(new Event('ended')) })

    await click('S6 すべて閉じる')
    await rejections.settle()
    expect(logText()).toContain('直前の録音を捨てる（S6）')
    expect(logText()).not.toContain('再生を止めた')
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH6: 再生に失敗した後に録音を捨てても、「再生を止めた」を出さない', async () => {
    setupPlayMock(true)
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
    await click('S6 すべて閉じる')
    expect(logText()).toContain('再生の失敗 name=NotAllowedError')
    expect(logText()).not.toContain('再生を止めた')
  })

  // HH9: 再生の途中のメディアのエラー
  async function recordAndPlay() {
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
    await click('直前の録音を再生')
  }

  it('HH9: play() が解決した後に error が起きると、「再生の失敗 code=…」と track の状態を1回だけ出し、その後に捨てても「再生を止めた」を出さない', async () => {
    const rejections = watchUnhandledRejections()
    const { play } = setupPlayMock()
    await recordAndPlay()
    const audio = play.mock.contexts[0] as HTMLAudioElement

    fireMediaError(audio, 3)
    let text = logText()
    expect(countMatches(text, /再生の失敗/)).toBe(2) // 失敗の行と、track の状態の「（再生の失敗）」
    expect(text).toMatch(/再生の失敗 code=3（S2 1回目の録音、5バイト/)
    expect(countMatches(text, /（再生の失敗）/)).toBe(1)

    await click('S6 すべて閉じる')
    await rejections.settle()
    text = logText()
    expect(text).toContain('直前の録音を捨てる（S6）')
    expect(text).not.toContain('再生を止めた')
    expect(countMatches(text, /再生の失敗 /)).toBe(1)
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH9: error の code が分からないときは、その旨を出す', async () => {
    const { play } = setupPlayMock()
    await recordAndPlay()
    fireMediaError(play.mock.contexts[0] as HTMLAudioElement)
    expect(logText()).toMatch(/再生の失敗 code=不明（S2 1回目の録音/)
  })

  it('HH9: play() の拒否の後に error が起きても、「再生の失敗」を1回だけ出す', async () => {
    const rejections = watchUnhandledRejections()
    const ctl = setupControlledPlayMock()
    await recordAndPlay()
    const audio = ctl.play.mock.contexts[0] as HTMLAudioElement

    await ctl.reject(audio, 'NotSupportedError')
    fireMediaError(audio, 4)
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生の失敗 /)).toBe(1)
    expect(text).toMatch(/再生の失敗 name=NotSupportedError（S2 1回目の録音/)
    expect(countMatches(text, /（再生の失敗）/)).toBe(1)
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH9: error の後に play() が拒否されても、「再生の失敗」を1回だけ出す', async () => {
    const rejections = watchUnhandledRejections()
    const ctl = setupControlledPlayMock()
    await recordAndPlay()
    const audio = ctl.play.mock.contexts[0] as HTMLAudioElement

    fireMediaError(audio, 4)
    await ctl.reject(audio, 'NotSupportedError')
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生の失敗 /)).toBe(1)
    expect(text).toMatch(/再生の失敗 code=4（S2 1回目の録音/)
    expect(countMatches(text, /（再生の失敗）/)).toBe(1)
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH9: 再生が始まった後に録音を捨てて止めた後に error が届いても、「再生の失敗」を出さない', async () => {
    const rejections = watchUnhandledRejections()
    const { play } = setupPlayMock()
    await recordAndPlay()
    const audio = play.mock.contexts[0] as HTMLAudioElement

    await click('S6 すべて閉じる')
    fireMediaError(audio, 1)
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生を止めた（/)).toBe(1)
    expect(text).not.toContain('再生の失敗')
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH9: 開始を待っている間に止め、error の後に AbortError で拒否されても、「再生を止めた」を1回だけ出し、「再生の失敗」を出さない', async () => {
    const rejections = watchUnhandledRejections()
    const ctl = setupControlledPlayMock()
    await recordAndPlay()
    const audio = ctl.play.mock.contexts[0] as HTMLAudioElement

    await click('S2 開始')
    fireMediaError(audio, 1)
    await ctl.reject(audio, 'AbortError')
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生を止めた（/)).toBe(1)
    expect(text).toMatch(/再生を止めた（録音を捨てたため）（S2 1回目の録音[^）]*）name=AbortError/)
    expect(text).not.toContain('再生の失敗')
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('HH9: 開始を待っている間の error の後に録音を捨てても、「再生を止めた」を出さない', async () => {
    const rejections = watchUnhandledRejections()
    const ctl = setupControlledPlayMock()
    await recordAndPlay()
    const audio = ctl.play.mock.contexts[0] as HTMLAudioElement

    fireMediaError(audio, 4)
    await click('S6 すべて閉じる')
    await ctl.reject(audio, 'AbortError')
    await rejections.settle()

    const text = logText()
    expect(countMatches(text, /再生の失敗 /)).toBe(1)
    expect(text).not.toContain('再生を止めた')
    expect(rejections.handler).not.toHaveBeenCalled()
  })
})

describe('MicTestPage: AudioContext で再生', () => {
  async function record() {
    await renderPage()
    await click('S2 開始')
    await click('S2 停止')
  }

  it('録音がないとき、テストが動いている間、開始を待っている間は押せない', async () => {
    const { Ctor } = setupAudioContextMock()
    setupRecognitionMock()
    await renderPage()
    expect(contextPlayButton()).toBeDisabled()

    await click('S2 開始')
    expect(contextPlayButton()).toBeDisabled()
    await click('S2 停止')
    expect(contextPlayButton()).toBeEnabled()

    // テストが動いている間
    await click('S3 開始')
    expect(contextPlayButton()).toBeDisabled()
    await click('S3 停止')
    expect(contextPlayButton()).toBeEnabled()

    // 開始を待っている間（S2 に切り替えると S3 のマイクを閉じて開き直すので、その getUserMedia を待たせる）
    setupDeferredGetUserMediaMock()
    await click('S2 開始')
    expect(contextPlayButton()).toBeDisabled()
    expect(Ctor).not.toHaveBeenCalled()
  })

  it('押すと decodeAudioData と start() を呼び、再生の前の track の状態と再生の開始をログに出す。<audio> では再生しない', async () => {
    const { play } = setupPlayMock()
    const { Ctor } = setupAudioContextMock()
    await record()
    await clickContextPlay()

    expect(Ctor).toHaveBeenCalledTimes(1)
    const context = audioContexts[0]
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(context.decodeAudioData.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
    expect(context.decodeAudioData.mock.calls[0][0].byteLength).toBe(5)
    expect(sources).toHaveLength(1)
    expect(sources[0].buffer).toEqual({ duration: 1.5 })
    expect(sources[0].connect).toHaveBeenCalledWith(context.destination)
    expect(sources[0].start).toHaveBeenCalledTimes(1)
    expect(context.resume).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()

    const text = logText()
    expect(text).toContain('AudioContext 作成 state=running sampleRate=48000 baseLatency=0.0050秒')
    expect(text).toContain('AudioContext decodeAudioData 成功 長さ=1.50秒')
    expect(text).toContain('track[0] readyState=live enabled=false muted=false（AudioContext 再生の前）')
    expect(text).toMatch(/AudioContext 再生の開始 state=running（S2 1回目の録音、5バイト、/)
  })

  it('onended で再生の終わりと track の状態をログに出す', async () => {
    setupAudioContextMock()
    await record()
    await clickContextPlay()
    finishSource(sources[0])

    const text = logText()
    expect(text).toMatch(/AudioContext 再生の終わり（S2 1回目の録音、5バイト、/)
    expect(text).toContain('track[0] readyState=live enabled=false muted=false（AudioContext 再生の終わり）')
    expect(text).not.toContain('再生を止めた')
  })

  it('AudioContext は2回押しても1つだけ作り、suspended のときは resume() して、state の変化をログに出す', async () => {
    const { Ctor } = setupAudioContextMock({ initialState: 'suspended' })
    await record()
    await clickContextPlay()

    const context = audioContexts[0]
    expect(context.resume).toHaveBeenCalledTimes(1)
    let text = logText()
    expect(text).toContain('AudioContext 作成 state=suspended')
    expect(text).toContain('AudioContext resume()（state=suspended）')
    expect(text).toContain('AudioContext state=running（変化）')
    expect(text).toContain('AudioContext resume() 成功 state=running')
    expect(sources[0].start).toHaveBeenCalledTimes(1)

    // iPhone でほかの音声に中断された場合
    act(() => { setContextState(context, 'interrupted') })
    expect(logText()).toContain('AudioContext state=interrupted（変化）')

    finishSource(sources[0])
    await clickContextPlay()
    expect(Ctor).toHaveBeenCalledTimes(1)
    expect(context.resume).toHaveBeenCalledTimes(2)
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2)
    expect(sources[1].start).toHaveBeenCalledTimes(1)
    text = logText()
    expect(countMatches(text, /AudioContext 作成/)).toBe(1)
    expect(text).toContain('AudioContext resume()（state=interrupted）')
  })

  it('running のときは、2回目も resume() を呼ばずに使い回す', async () => {
    const { Ctor } = setupAudioContextMock()
    await record()
    await clickContextPlay()
    finishSource(sources[0])
    await clickContextPlay()
    expect(Ctor).toHaveBeenCalledTimes(1)
    expect(audioContexts[0].resume).not.toHaveBeenCalled()
    expect(sources[1].start).toHaveBeenCalledTimes(1)
  })

  it('decodeAudioData の失敗を name と track の状態を付けてログに出し、未処理の拒否にしない', async () => {
    const rejections = watchUnhandledRejections()
    setupAudioContextMock({ decodeFails: true })
    await record()
    await clickContextPlay()
    await rejections.settle()

    const text = logText()
    expect(text).toMatch(/AudioContext decodeAudioData 失敗 name=EncodingError type=（空）（S2 1回目の録音/)
    expect(text).toContain('（AudioContext 再生の失敗）')
    expect(sources).toHaveLength(0)
    expect(rejections.handler).not.toHaveBeenCalled()
    // 失敗した後に録音を捨てても、「再生を止めた」を出さない
    await click('S6 すべて閉じる')
    expect(logText()).not.toContain('再生を止めた')
  })

  it('II3: baseLatency がないブラウザでは、作成のログに sampleRate だけを出す', async () => {
    setupAudioContextMock({ noBaseLatency: true })
    await record()
    await clickContextPlay()
    const text = logText()
    expect(text).toContain('AudioContext 作成 state=running sampleRate=48000')
    expect(text).not.toContain('baseLatency')
  })

  it('II3: decodeAudioData の失敗のログに、録音の Blob の type を出す', async () => {
    setupMediaRecorderMock()
    ;(MediaRecorder.isTypeSupported as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t === 'audio/mp4')
    setupAudioContextMock({ decodeFails: true })
    await record()
    await clickContextPlay()
    expect(logText()).toMatch(/AudioContext decodeAudioData 失敗 name=EncodingError type=audio\/mp4（S2 1回目の録音/)
  })

  it('resume() の失敗を name を付けてログに出し、再生せず、未処理の拒否にしない', async () => {
    const rejections = watchUnhandledRejections()
    setupAudioContextMock({ initialState: 'suspended', resumeFails: true })
    await record()
    await clickContextPlay()
    await rejections.settle()

    const text = logText()
    expect(text).toContain('AudioContext resume() 失敗 name=NotAllowedError')
    expect(text).toMatch(/AudioContext 再生しない（resume\(\) に失敗したため）（S2 1回目の録音/)
    expect(audioContexts[0].decodeAudioData).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('AudioContext がないブラウザでは、対応していないとログに出す', async () => {
    await record()
    await clickContextPlay()
    expect(logText()).toContain('AudioContext このブラウザは対応していません')
  })

  const stopWays = [
    { name: '次の録音の開始', closes: false, act: () => click('S2 開始') },
    { name: 'S6', closes: true, act: () => click('S6 すべて閉じる') },
    { name: 'pagehide', closes: true, act: async () => { act(() => { window.dispatchEvent(new Event('pagehide')) }) } },
  ]
  for (const way of stopWays) {
    it(`再生している間に${way.name}で、stop() を呼び、止めたことを1回だけログに出す。close() は${way.closes ? '呼ぶ' : '呼ばない'}`, async () => {
      const rejections = watchUnhandledRejections()
      setupAudioContextMock()
      await record()
      await clickContextPlay()
      await way.act()
      // stop() の後に届く onended では「再生の終わり」を出さない
      finishSource(sources[0])
      await rejections.settle()

      const context = audioContexts[0]
      expect(sources[0].stop).toHaveBeenCalledTimes(1)
      const text = logText()
      expect(countMatches(text, /AudioContext 再生を止めた（/)).toBe(1)
      expect(text).toMatch(/AudioContext 再生を止めた（録音を捨てたため）（S2 1回目の録音、5バイト/)
      expect(countMatches(text, /（AudioContext 再生を止めた）/)).toBe(1)
      expect(text).not.toContain('AudioContext 再生の終わり')
      if (way.closes) {
        expect(context.close).toHaveBeenCalledTimes(1)
        expect(text).toContain('AudioContext close()')
        expect(text).toContain('AudioContext state=closed（変化）')
      } else {
        expect(context.close).not.toHaveBeenCalled()
        expect(text).not.toContain('AudioContext close()')
      }
      expect(rejections.handler).not.toHaveBeenCalled()
    })
  }

  it('再生している間にコンポーネントが外れたら、stop() と close() を呼ぶ', async () => {
    const consoleError = vi.spyOn(console, 'error')
    setupAudioContextMock()
    const { unmount } = render(<MicTestPage />)
    await click('S2 開始')
    await click('S2 停止')
    await clickContextPlay()
    expect(sources[0].start).toHaveBeenCalledTimes(1)
    unmount()
    expect(sources[0].stop).toHaveBeenCalledTimes(1)
    expect(audioContexts[0].close).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('次の録音の開始では閉じずに使い回し、S6 の後に押すと新しく作る', async () => {
    const { Ctor } = setupAudioContextMock()
    await record()
    await clickContextPlay()
    await click('S2 開始')
    await click('S2 停止')
    await clickContextPlay()
    expect(Ctor).toHaveBeenCalledTimes(1)
    expect(audioContexts[0].close).not.toHaveBeenCalled()

    await click('S6 すべて閉じる')
    expect(audioContexts[0].close).toHaveBeenCalledTimes(1)
    await click('S2 開始')
    await click('S2 停止')
    await clickContextPlay()
    expect(Ctor).toHaveBeenCalledTimes(2)
    expect(sources[2].start).toHaveBeenCalledTimes(1)
  })

  it('S6 を押しても、AudioContext を作っていなければ close() のログを出さない', async () => {
    setupAudioContextMock()
    await record()
    await click('S6 すべて閉じる')
    expect(logText()).not.toContain('AudioContext')
  })

  it('もう一度押すと、前の再生を止めて新しく再生する', async () => {
    setupAudioContextMock()
    await record()
    await clickContextPlay()
    await clickContextPlay()
    expect(sources[0].stop).toHaveBeenCalledTimes(1)
    expect(sources[1].start).toHaveBeenCalledTimes(1)
    expect(logText()).toMatch(/AudioContext 再生を止めた（もう一度再生したため）（S2 1回目の録音/)
  })

  it('decodeAudioData を待っている間に S6 を押すと、開始の前に止めたとログに出し、待った後に再生しない', async () => {
    const rejections = watchUnhandledRejections()
    const { resolveDecode } = setupAudioContextMock({ deferDecode: true })
    await record()
    await clickContextPlay()
    expect(audioContexts[0].decodeAudioData).toHaveBeenCalledTimes(1)

    await click('S6 すべて閉じる')
    await resolveDecode()
    await rejections.settle()

    const text = logText()
    expect(sources).toHaveLength(0)
    expect(countMatches(text, /AudioContext 再生を止めた（/)).toBe(1)
    expect(text).toMatch(/AudioContext 再生を止めた（録音を捨てたため、開始の前）（S2 1回目の録音/)
    expect(text).not.toContain('AudioContext 再生の開始')
    expect(rejections.handler).not.toHaveBeenCalled()
  })

  it('<audio> の再生と AudioContext の再生は、互いに止めない', async () => {
    const { pause } = setupPlayMock()
    setupAudioContextMock()
    await record()
    await clickContextPlay()
    await click('直前の録音を再生')
    expect(sources[0].stop).not.toHaveBeenCalled()
    await clickContextPlay()
    expect(pause).not.toHaveBeenCalled()
  })

  it('送信も保存もしない（fetch と localStorage を使わない）', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setupAudioContextMock()
    await record()
    await clickContextPlay()
    finishSource(sources[0])
    await click('S6 すべて閉じる')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })
})
