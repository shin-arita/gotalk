import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import App from '../App'
import MicTestPage from './MicTestPage'

const DESCRIPTION =
  'マイク動作確認用の開発ページです。録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信・保存しません。音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。'

// --- getUserMedia mock ---

interface MockTrack {
  enabled: boolean
  readyState: string
  stop: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
}

let tracks: MockTrack[] = []

function makeTrack(): MockTrack {
  const track: MockTrack = {
    enabled: true,
    readyState: 'live',
    stop: vi.fn(() => { track.readyState = 'ended' }),
    addEventListener: vi.fn(),
  }
  tracks.push(track)
  return track
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

// --- MediaRecorder mock ---

interface MockRecorder {
  state: string
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
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
      onstop: null,
      start: vi.fn(() => { recorder.state = 'recording' }),
      stop: vi.fn(() => {
        recorder.state = 'inactive'
        recorder.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) })
        recorder.onstop?.()
      }),
    }
    recorders.push(recorder)
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
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

let recognitions: MockRecognition[] = []

function setupRecognitionMock() {
  const Ctor = vi.fn(function () {
    const recognition: MockRecognition = {
      lang: '',
      continuous: false,
      interimResults: false,
      onresult: null,
      start: vi.fn(),
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

beforeEach(() => {
  savedProperties = []
  saveProperty(globalThis.navigator, 'mediaDevices')
  saveProperty(globalThis.navigator, 'permissions')
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
    expect(logText()).toContain('track[0] readyState=live enabled=false（S2 停止）')
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
})
