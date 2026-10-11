import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import App from '../App'
import MicTestPage from './MicTestPage'

const DESCRIPTION =
  'マイク動作確認用の開発ページです。録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信・保存しません。音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。録音した音声は、このページの中で再生するためだけにメモリに持ちます。送信も保存もしません。次の録音を始めたとき、S6 を押したとき、ページを閉じたときに捨てます。'

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

function setupMediaRecorderMock() {
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
        recorder.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) })
        recorder.onstop?.(new Event('stop'))
      }),
    }
    recorders.push(recorder)
    return recorder
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
  Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
  Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
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

function playButton() {
  return screen.getByRole('button', { name: '直前の録音を再生' })
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
    await click('S2 開始')
    // 実際のブラウザと同じく、onstop は stop() の後に遅れて届く
    const recorder = recorders[0]
    recorder.stop.mockImplementation(() => { recorder.state = 'inactive' })
    await click('S6 すべて閉じる')
    act(() => {
      recorder.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) })
      recorder.onstop?.(new Event('stop'))
    })
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
})
