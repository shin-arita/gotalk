import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'
import { MESSAGES, getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { makeTtsOkResponse, setupAudioContext } from '../test/audioMocks'
import type { FakeAudioContext } from '../test/audioMocks'
import type { AudioSession } from '../hooks/useAudioSession'

// 画面の状態（idle と ready など、画面の見た目では区別できないもの）を、録音のセッションの診断の出来事（status:…）で確かめる。
// 録音のセッションは本物を使い、画面で使うものを取っておく（InterpreterPage.recordingOverlay.test.tsx と同じ）
const captured = vi.hoisted(() => ({ session: null as AudioSession | null }))

vi.mock('../hooks/useKeptAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useKeptAudioSession')>()
  return {
    ...actual,
    useInterpreterAudioSession: (...args: Parameters<typeof actual.useInterpreterAudioSession>) => {
      const session = actual.useInterpreterAudioSession(...args)
      captured.session = session
      return session
    },
  }
})

// 最後に記録された画面の状態
const lastStatus = () => captured.session!.getDiagnostics().events.map(e => e.type).filter(t => t.startsWith('status:')).at(-1)

// --- Shared fixtures ---

const [ja, en] = LANGUAGES

// renderPage の既定の言語（日本語と英語）で表示する文言
const jaEn = (key: MessageKey) => getLocalizedMessage(key, 'ja', 'en')

function renderPage(
  selectedLanguages: Language[] = [ja, en],
  onBack = vi.fn(),
) {
  return render(
    <InterpreterPage
      selectedLanguages={selectedLanguages}
      onBack={onBack}
    />,
  )
}

function makeInterpretResponse(overrides: Partial<{
  text: string
  translatedText: string
  ttsText: string
  backTranslation: string
  sourceLanguage: string
  targetLanguage: string
}> = {}) {
  return {
    text: 'Hello',
    translatedText: 'こんにちは',
    ttsText: 'こんにちは',
    backTranslation: '(Hello)',
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    ...overrides,
  }
}

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function make422Response(body: object): Response {
  return {
    ok: false,
    status: 422,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function make500Response(): Response {
  return {
    ok: false,
    status: 500,
    json: () => Promise.resolve({}),
  } as unknown as Response
}

// --- Audio / TTS mock ---

// 録音のデータ。マイクの音が来ていないかの判定（MIN_INTERPRET_AUDIO_BYTES 未満は送らない）に掛からない大きさにする
const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)

// 読み上げは AudioContext で鳴らす（<audio> は使わない）。音量の取得も同じ AudioContext の代わりを使う
let audioContexts: FakeAudioContext[] = []

function setupAudioMock() {
  audioContexts = setupAudioContext().instances
}

// 今鳴らしている読み上げの音（最後に作った AudioBufferSourceNode）
function lastBufferSource() {
  return audioContexts.flatMap(c => c.bufferSources).at(-1)
}

const makeAudioOkResponse = makeTtsOkResponse

// ============================================================
// MediaRecorder / getUserMedia mock helpers (flag-tap tests)
// ============================================================

interface MockRecorderInstance {
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  state: string
}

let mockRecorder: MockRecorderInstance | undefined

function setupMediaRecorderMock() {
  const mock: MockRecorderInstance = {
    ondataavailable: null,
    onstop: null,
    start: vi.fn(),
    stop: vi.fn(),
    state: 'inactive',
  }
  const Ctor = vi.fn(function () {
    mock.state = 'recording'
    mockRecorder = mock
    return mock
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
  Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
  mock.stop = vi.fn(function () {
    mock.state = 'inactive'
    mock.onstop?.()
  })
  Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
  return mock
}

// getUserMedia が返す stream の代わり。audio track が1本で、readyState は live
function makeFakeStream() {
  const track = { kind: 'audio', readyState: 'live', enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn() }
  return { getTracks: () => [track], getAudioTracks: () => [track] }
}

function setupGetUserMediaMock(rejects = false) {
  const fakeStream = makeFakeStream()
  const getUserMedia = rejects
    ? vi.fn().mockRejectedValue(new Error('Permission denied'))
    : vi.fn().mockResolvedValue(fakeStream)
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
  return getUserMedia
}

// 日本語の国旗をタップして録音を開始し、同じ国旗をタップして停止することで /api/interpret を呼ぶ
async function renderAndInterpret() {
  mockRecorder = undefined
  setupMediaRecorderMock()
  setupGetUserMediaMock()
  renderPage([ja, en])

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
  })
  act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
  })
}

// --- Lifecycle ---

// テストで置き換える global を、テスト前の状態（property がない場合も含む）に戻す
type SavedProperty = { target: object; key: string; descriptor: PropertyDescriptor | undefined }
let savedProperties: SavedProperty[] = []

function saveProperty(target: object, key: string) {
  savedProperties.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
}

beforeEach(() => {
  // エラーのときのログ（console.warn）は、ログを確かめるテスト以外では出さない
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // マイクはページ全体で1つ持つので、テストごとに空にする
  resetKeptMicForTest()
  savedProperties = []
  saveProperty(globalThis, 'AudioContext')
  saveProperty(globalThis.navigator, 'mediaDevices')
  saveProperty(globalThis.URL, 'createObjectURL')
  saveProperty(globalThis.URL, 'revokeObjectURL')
  saveProperty(globalThis, 'Audio')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).MediaRecorder
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  for (const { target, key, descriptor } of savedProperties) {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else delete (target as Record<string, unknown>)[key]
  }
})

// ============================================================
// Language Mismatch — interpret API
// ============================================================

describe('InterpreterPage language mismatch (interpret API)', () => {
  it('shows mismatch messages for all selected languages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    const msg = screen.getByRole('alert').textContent ?? ''
    // 選んだ順に、空行をはさんで並べる（共通の関数に寄せる前と同じ表示）
    expect(msg).toBe('言語不明、もう一度お話ください\n\nLanguage unclear. Please speak again.')
  })

  it('clears translated text on mismatch (speak button hidden)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()
  })

  it('resets status to idle after mismatch (speak button hidden)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()
  })
})

// ============================================================
// Language Mismatch — translate API (via edit flow)
// ============================================================

describe('InterpreterPage language mismatch (translate API)', () => {
  it('shows mismatch error when retranslate API returns 422', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(make422Response({ error: 'language_mismatch' }))

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByText('Hello', { selector: '.source-card__text' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const textarea = screen.getByRole('textbox', { name: '原文を編集' })
    fireEvent.change(textarea, { target: { value: 'Changed text' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain('言語不明')
  })
})

// ============================================================
// Translation Response
// ============================================================

describe('InterpreterPage translation response', () => {
  it('shows translated text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'おはようございます' })),
    )
    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByText('おはようございます', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
  })

  it('shows back translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ backTranslation: '(Good morning JP)' })),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByText('(Good morning JP)')).toBeInTheDocument())
  })

  it('shows speak button after successful translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )
  })

  it('shows the generic error message on HTTP 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(make500Response())
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toBe(jaEn('generic_error'))
  })
})

// ============================================================
// History
// ============================================================

describe('InterpreterPage history', () => {
  it('adds one history entry after a successful translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ text: 'Hi', translatedText: 'やあ' })),
    )
    await renderAndInterpret()
    await waitFor(() =>
      expect(document.querySelectorAll('.history-item')).toHaveLength(1),
    )
    expect(document.querySelector('.history-item__source')?.textContent).toBe('Hi')
    expect(document.querySelector('.history-item__translation')?.textContent).toBe('やあ')
  })

  it('shows all history entries without expand button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeOkResponse(makeInterpretResponse()),
    )
    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '編集' })).not.toBeDisabled(),
    )

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole('button', { name: '編集' }))
      const textarea = screen.getByRole('textbox', { name: '原文を編集' })
      fireEvent.change(textarea, { target: { value: `retranslate-${i}` } })
      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
      })
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '編集' })).not.toBeDisabled(),
      )
    }

    expect(document.querySelectorAll('.history-item')).toHaveLength(6)
    expect(screen.queryByRole('button', { name: '履歴をすべて表示' })).not.toBeInTheDocument()
  })
})

// ============================================================
// TTS (OpenAI)
// ============================================================

describe('InterpreterPage TTS (OpenAI)', () => {
  beforeEach(() => {
    setupAudioMock()
  })

  it('speak button is absent before any translation', () => {
    renderPage([ja, en])
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()
  })

  it('speak button appears after translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )
  })

  it('clicking speak POSTs to /api/tts with ttsText from response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは', ttsText: 'Konnichiwa' })))
    fetchMock.mockResolvedValueOnce(makeAudioOkResponse())

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Konnichiwa' }),
      signal: expect.any(AbortSignal),
    })
  })

  it('speak button is disabled while TTS fetch is in progress', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockReturnValueOnce(new Promise(() => {}))

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    expect(screen.getByRole('button', { name: '発声する' })).toBeDisabled()
  })

  it('speak button re-enables after audio onended', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeAudioOkResponse())

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))

    await waitFor(() => expect(lastBufferSource()?.start).toHaveBeenCalled())
    act(() => { lastBufferSource()!.onended?.() })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  it('speak button re-enables after TTS fetch error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(make500Response())

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled(),
    )
  })
})

// ============================================================
// Translate API 500 (retranslation error)
// ============================================================

describe('InterpreterPage translate API 500', () => {
  it('shows the generic error message on retranslation failure (HTTP 500)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(make500Response())

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '編集' })).not.toBeDisabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const textarea = screen.getByRole('textbox', { name: '原文を編集' })
    fireEvent.change(textarea, { target: { value: 'Retranslate me' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toBe(jaEn('generic_error'))
  })

  it('clears previous translatedText and the speak button after 500', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは' })),
    )
    fetchMock.mockResolvedValueOnce(make500Response())

    await renderAndInterpret()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '編集' })).not.toBeDisabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const textarea = screen.getByRole('textbox', { name: '原文を編集' })
    fireEvent.change(textarea, { target: { value: 'Retranslate me' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toBe(jaEn('generic_error'))
    // 訳し直しを始めるときに前の翻訳を消すので、失敗しても前の翻訳と読み上げのボタンは出ず、idle になる
    expect(
      screen.queryByText('こんにちは', { selector: '.translation-card__text' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()
    expect(lastStatus()).toBe('status:idle')
  })
})

// ============================================================
// Language flags bar
// ============================================================

describe('InterpreterPage language flags bar', () => {
  it('renders flag buttons for both selected languages', () => {
    renderPage([ja, en])
    expect(screen.getByRole('button', { name: 'Japaneseで話す' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Englishで話す' })).toBeInTheDocument()
  })

  it('does not render flags bar when fewer than 2 languages provided', () => {
    renderPage([ja])
    expect(screen.queryByRole('button', { name: 'Japaneseで話す' })).not.toBeInTheDocument()
  })

  it('does not render a bottom mic button', () => {
    renderPage([ja, en])
    expect(screen.queryByRole('button', { name: '話す' })).not.toBeInTheDocument()
  })
})

// ============================================================
// Recording — translation visibility
// ============================================================

describe('InterpreterPage translation visibility during recording', () => {
  it('hides translation card while recording', async () => {
    const mock = {
      ondataavailable: null as ((e: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      state: 'inactive',
    }
    const Ctor = vi.fn(function () { mock.state = 'recording'; return mock }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
    Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
    mock.stop = vi.fn(function () { mock.state = 'inactive'; mock.onstop?.() })
    Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(makeFakeStream()) },
      writable: true, configurable: true,
    })

    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })

    expect(document.querySelector('.translation-card')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()

    Object.defineProperty(globalThis, 'MediaRecorder', { value: undefined, writable: true, configurable: true })
  })

  it('shows translation card after recording ends', async () => {
    let mockRec2: { ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null; stop: ReturnType<typeof vi.fn>; state: string } | undefined
    const mock2 = {
      ondataavailable: null as ((e: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      state: 'inactive',
    }
    const Ctor2 = vi.fn(function () { mock2.state = 'recording'; mockRec2 = mock2; return mock2 }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
    Ctor2.isTypeSupported = vi.fn().mockReturnValue(false)
    mock2.stop = vi.fn(function () { mock2.state = 'inactive'; mock2.onstop?.() })
    Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor2, writable: true, configurable: true })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(makeFakeStream()) },
      writable: true, configurable: true,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは' })),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRec2!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    await waitFor(() =>
      expect(screen.getByText('こんにちは', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
    expect(document.querySelector('.translation-card')).toBeInTheDocument()

    Object.defineProperty(globalThis, 'MediaRecorder', { value: undefined, writable: true, configurable: true })
  })
})

// ============================================================
// Flag-tap recording
// ============================================================

describe('InterpreterPage flag-tap recording', () => {
  beforeEach(() => {
    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).MediaRecorder
  })

  it('tapping left flag calls getUserMedia and shows recording state', async () => {
    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    expect(screen.getByRole('button', { name: 'Japaneseの録音を停止' })).toBeInTheDocument()
  })

  it('tapping right flag starts recording for the right language', async () => {
    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Englishで話す' }))
    })
    expect(screen.getByRole('button', { name: 'Englishの録音を停止' })).toBeInTheDocument()
  })

  it('opposite flag is disabled during recording', async () => {
    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    expect(screen.getByRole('button', { name: 'Englishで話す' })).toBeDisabled()
  })

  it('re-tapping the same flag stops recording and calls /api/interpret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/interpret', expect.objectContaining({ method: 'POST' }))
  })

  it('sends left flag language as speaker', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    const [, options] = fetchMock.mock.calls[0]
    const body = (options as RequestInit).body as FormData
    expect(body.get('speaker')).toBe('ja')
    expect(JSON.parse(body.get('myLanguage') as string).id).toBe('ja')
    expect(JSON.parse(body.get('theirLanguage') as string).id).toBe('en')
  })

  it('sends right flag language as speaker', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Englishで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Englishの録音を停止' }))
    })

    const [, options] = fetchMock.mock.calls[0]
    const body = (options as RequestInit).body as FormData
    expect(body.get('speaker')).toBe('en')
    expect(JSON.parse(body.get('myLanguage') as string).id).toBe('en')
    expect(JSON.parse(body.get('theirLanguage') as string).id).toBe('ja')
  })

  it('both flags are re-enabled after recording completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Japaneseで話す' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Englishで話す' })).not.toBeDisabled()
  })

  it('shows mic access error when getUserMedia rejects', async () => {
    setupGetUserMediaMock(true)
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toBe(jaEn('microphone_denied'))
  })

  it('sends the live SpeechRecognition transcript and keeps it as the source text', async () => {
    const recognition = {
      lang: '',
      interimResults: false,
      continuous: false,
      onresult: null as ((e: { results: { transcript: string }[][] }) => void) | null,
      onerror: null as (() => void) | null,
      onend: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
    }
    Object.defineProperty(window, 'SpeechRecognition', {
      value: vi.fn(function () { return recognition }),
      writable: true,
      configurable: true,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ text: 'Whisper text', translatedText: 'Hello' })),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    expect(recognition.lang).toBe(ja.speechCode)
    expect(recognition.start).toHaveBeenCalled()
    act(() => { recognition.onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/interpret')
    expect(((options as RequestInit).body as FormData).get('transcript')).toBe('こんにちは')
    await waitFor(() =>
      expect(screen.getByText('Hello', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
    expect(screen.getByText('こんにちは', { selector: '.source-card__text' })).toBeInTheDocument()
    expect(screen.queryByText('Whisper text', { selector: '.source-card__text' })).not.toBeInTheDocument()
  })

  it('translation result and history are added after flag-tap recording', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ text: 'こんにちは', translatedText: 'Hello' })),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    await waitFor(() =>
      expect(screen.getByText('Hello', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
    expect(document.querySelector('.history-item__source')?.textContent).toBe('こんにちは')
  })
})

// ============================================================
// Request limits: fetch signal / timeout / error codes
// ============================================================

function makeErrorResponse(status: number, body: object): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// signal が abort されるまで解決しない fetch の応答
function pendingUntilAborted(options?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

function setupSpeechRecognitionMock() {
  const recognition = {
    lang: '',
    interimResults: false,
    continuous: false,
    onresult: null as ((e: { results: { transcript: string }[][] }) => void) | null,
    onerror: null as (() => void) | null,
    onend: null as (() => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
  }
  Object.defineProperty(window, 'SpeechRecognition', {
    value: vi.fn(function () { return recognition }),
    writable: true,
    configurable: true,
  })
  return recognition
}

// 翻訳の結果が出た後に原文を編集して /api/translate を呼ぶ
async function editAndRetranslate(text: string) {
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  const textarea = screen.getByRole('textbox', { name: '原文を編集' })
  fireEvent.change(textarea, { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(textarea, { key: 'Enter' })
  })
}

describe('InterpreterPage fetch signal and timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes an AbortSignal to every fetch and sends only the fields the backend accepts', async () => {
    setupAudioMock()
    const recognition = setupSpeechRecognitionMock()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ text: 'こんにちは' })))
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ translatedText: 'Hi' })))
    fetchMock.mockResolvedValueOnce(makeAudioOkResponse())

    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { recognition.onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
    await act(async () => { vi.advanceTimersByTime(800) })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('こんばんは')
    await waitFor(() => expect(screen.getByText('Hi', { selector: '.translation-card__text' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })

    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toEqual(['/api/interpret', '/api/translate', '/api/tts'])
    for (const [, options] of fetchMock.mock.calls) {
      expect((options as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }

    // Backend は JSON の未知のフィールドを拒否する（DisallowUnknownFields）ので、送るフィールドを固定する
    const jsonBody = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string)
    const translateBody = jsonBody(1)
    expect(Object.keys(translateBody).sort()).toEqual(['languages', 'text'])
    for (const lang of translateBody.languages) expect(Object.keys(lang).sort()).toEqual(['id', 'label'])
    expect(Object.keys(jsonBody(2))).toEqual(['text'])
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData
    expect([...form.keys()].sort()).toEqual(['audio', 'myLanguage', 'speaker', 'theirLanguage', 'transcript'])
    expect(Object.keys(JSON.parse(form.get('myLanguage') as string)).sort()).toEqual(['id', 'label'])
  })

  it('aborts /api/interpret after 65 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let signal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      signal = options?.signal ?? undefined
      return pendingUntilAborted(options)
    })
    await renderAndInterpret()
    expect(signal).toBeDefined()

    await act(async () => { vi.advanceTimersByTime(64_000) })
    expect(signal!.aborted).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(signal!.aborted).toBe(true)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('request_timeout')))
  })

  it('aborts /api/translate after 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let signal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockImplementationOnce((_url, options) => {
      signal = options?.signal ?? undefined
      return pendingUntilAborted(options)
    })
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('Good evening')

    await act(async () => { vi.advanceTimersByTime(29_000) })
    expect(signal!.aborted).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(signal!.aborted).toBe(true)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('request_timeout')))
  })

  it('aborts /api/tts after 30 seconds and re-enables the speak button', async () => {
    setupAudioMock()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let signal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockImplementationOnce((_url, options) => {
      signal = options?.signal ?? undefined
      return pendingUntilAborted(options)
    })
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })
    expect(screen.getByRole('button', { name: '発声する' })).toBeDisabled()

    await act(async () => { vi.advanceTimersByTime(29_000) })
    expect(signal!.aborted).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(signal!.aborted).toBe(true)
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled())
  })
})

describe('InterpreterPage error codes', () => {
  const cases: [string, string][] = [
    ['input_too_large', jaEn('input_too_large')],
    ['service_unavailable', jaEn('service_unavailable')],
    ['upstream_busy', jaEn('upstream_busy')],
    ['timeout', jaEn('timeout')],
  ]
  const statusFor: Record<string, number> = { input_too_large: 413, service_unavailable: 503, upstream_busy: 503, timeout: 504 }

  for (const [code, message] of cases) {
    it(`shows the message for ${code} from /api/interpret`, async () => {
      // /api/interpret の 413 は録音用の文言になる（interpret 413 のテストを参照）ので、input_too_large は
      // 400（transcript が長すぎる場合）で確かめる
      const status = code === 'input_too_large' ? 400 : statusFor[code]
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeErrorResponse(status, { error: 'upstream busy', code }),
      )
      await renderAndInterpret()
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    })

    it(`shows the message for ${code} from /api/translate`, async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockResolvedValueOnce(makeErrorResponse(statusFor[code], { error: 'x', code }))
      await renderAndInterpret()
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
      await editAndRetranslate('Good evening')
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    })

    it(`shows the message for ${code} from /api/tts (input_too_large uses the TTS message)`, async () => {
      setupAudioMock()
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockResolvedValueOnce(makeErrorResponse(statusFor[code], { error: 'x', code }))
      await renderAndInterpret()
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '発声する' }))
      })
      // /api/tts の input_too_large は、読み上げ用の文言にする（TTS length limit のテストを参照）
      const ttsMessage = code === 'input_too_large' ? jaEn('tts_too_long') : message
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(ttsMessage))
      expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
    })
  }

  it('does not show unknown codes or OpenAI details, and shows the generic error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeErrorResponse(502, { error: 'translation failed', code: 'insufficient_quota' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('generic_error')))
  })

  it('keeps the TTS error silent for codes without a message', async () => {
    setupAudioMock()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeErrorResponse(502, { error: 'tts failed', code: 'upstream_error' }))
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('InterpreterPage TTS length limit', () => {
  const TOO_LONG = jaEn('tts_too_long')

  // 翻訳の結果（ttsText と translatedText）を text にして、読み上げボタンを押す
  async function speak(text: string, ttsResponse: Response = makeAudioOkResponse()) {
    setupAudioMock()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ translatedText: text, ttsText: text })))
    fetchMock.mockResolvedValueOnce(ttsResponse)
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })
    return fetchMock
  }

  const ttsCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/tts')

  it('calls /api/tts for exactly 500 characters', async () => {
    const fetchMock = await speak('あ'.repeat(500))
    expect(ttsCalls(fetchMock)).toHaveLength(1)
    expect(screen.queryByText(TOO_LONG)).not.toBeInTheDocument()
  })

  it('does not call /api/tts for 501 characters, shows the message, and keeps the full translation', async () => {
    const text = 'あ'.repeat(500) + 'い'
    const fetchMock = await speak(text)
    expect(ttsCalls(fetchMock)).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe(TOO_LONG)
    expect(screen.getByText(text, { selector: '.translation-card__text' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  // Backend の textTooLong は前後の空白を除かずに数えるので、Frontend も空白を数える
  it('counts surrounding spaces like the backend', async () => {
    const fetchMock = await speak(' ' + 'a'.repeat(499) + ' ')
    expect(ttsCalls(fetchMock)).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe(TOO_LONG)
  })

  it('calls /api/tts when the text with its surrounding spaces is within 500 characters', async () => {
    const fetchMock = await speak(' ' + 'a'.repeat(498) + ' ')
    expect(ttsCalls(fetchMock)).toHaveLength(1)
  })

  it('counts surrogate-pair characters as one', async () => {
    const fetchMock = await speak('😀'.repeat(500))
    expect(ttsCalls(fetchMock)).toHaveLength(1)
  })

  it('does not call /api/tts for 501 surrogate-pair characters', async () => {
    const fetchMock = await speak('😀'.repeat(501))
    expect(ttsCalls(fetchMock)).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe(TOO_LONG)
  })

  it('shows the message when /api/tts returns 400 input_too_large', async () => {
    await speak('short text', makeErrorResponse(400, { error: 'text must be at most 500 characters', code: 'input_too_large' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
    expect(screen.getByText('short text', { selector: '.translation-card__text' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  it('keeps the input_too_large message of /api/translate', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, { error: 'x', code: 'input_too_large' }))
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('Good evening')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('input_too_large')))
  })
})

describe('InterpreterPage /api/interpret 413 (recording too long)', () => {
  const TOO_LONG = jaEn('recording_too_long')
  const LIMIT = 1_032_192

  // nginx の client_max_body_size を超えたときの応答（本文は HTML で、JSON として読めない）
  function makeNginx413Response(): Response {
    return {
      ok: false,
      status: 413,
      headers: new Headers({ 'Content-Type': 'text/html' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      text: () => Promise.resolve('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>'),
    } as unknown as Response
  }

  // size バイトの録音で国旗をタップして録音し、止めて /api/interpret を呼ぶ
  async function renderAndInterpretWithSize(size: number) {
    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
    renderPage([ja, en])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })
  }

  // エラーを表示した後の画面の状態
  function screenState() {
    return {
      alert: screen.queryByRole('alert')?.textContent ?? null,
      leftFlagEnabled: !(screen.getByRole('button', { name: 'Japaneseで話す' }) as HTMLButtonElement).disabled,
      rightFlagEnabled: !(screen.getByRole('button', { name: 'Englishで話す' }) as HTMLButtonElement).disabled,
      recording: screen.queryByRole('button', { name: 'Japaneseの録音を停止' }) !== null,
      speakButton: screen.queryByRole('button', { name: '発声する' }) !== null,
      translationCard: document.querySelector('.translation-card') !== null,
      processing: document.querySelector('.translation-card__text--processing') !== null,
      history: document.querySelectorAll('.history-item').length,
    }
  }

  it('shows the recording message when nginx returns an HTML 413', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeNginx413Response())
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
  })

  it('shows the recording message when the backend returns a JSON 413 input_too_large', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeErrorResponse(413, { error: 'request body too large', code: 'input_too_large' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
  })

  it('shows the recording message when a 413 has an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 413,
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      text: () => Promise.resolve(''),
    } as unknown as Response)
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
  })

  it('shows the generic error message for other errors (502 upstream_error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeErrorResponse(502, { error: 'translation failed', code: 'upstream_error' }),
    )
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('generic_error')))
  })

  it('sends a recording of exactly the limit (1,032,192 bytes)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    await renderAndInterpretWithSize(LIMIT)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/interpret')
    expect(((options as RequestInit).body as FormData).get('audio')).toHaveProperty('size', LIMIT)
    expect(screen.queryByText(TOO_LONG)).not.toBeInTheDocument()
  })

  it('does not send a recording one byte over the limit and shows the recording message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await renderAndInterpretWithSize(LIMIT + 1)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the existing message for a 413 from /api/translate', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeErrorResponse(413, { error: 'request body too large', code: 'input_too_large' }))
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('Good evening')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('input_too_large')))
  })

  it('keeps the TTS message for a 413 input_too_large from /api/tts', async () => {
    setupAudioMock()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeErrorResponse(413, { error: 'request body too large', code: 'input_too_large' }))
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(jaEn('tts_too_long')))
  })

  it('leaves the screen in the same state as other /api/interpret errors', async () => {
    // 比べる基準：502 のとき
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(502, { error: 'x', code: 'upstream_error' }))
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    const base = { ...screenState(), alert: null }
    cleanup()
    vi.restoreAllMocks()

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeNginx413Response())
    await renderAndInterpret()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
    expect({ ...screenState(), alert: null }).toEqual(base)
    cleanup()
    vi.restoreAllMocks()

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await renderAndInterpretWithSize(LIMIT + 1)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOO_LONG))
    expect({ ...screenState(), alert: null }).toEqual(base)
    expect(fetchMock).not.toHaveBeenCalled()

    // 基準の状態：録音していない、両方の国旗が押せる、読み上げボタンがない、翻訳カードがあり処理中でない、履歴がない
    expect(base).toEqual({
      alert: null, leftFlagEnabled: true, rightFlagEnabled: true, recording: false,
      speakButton: false, translationCard: true, processing: false, history: 0,
    })
  })
})

// ============================================================
// 利用者向けの文言を、選んだ2つの言語で表示する（docs/ui.md）
// ============================================================

describe('InterpreterPage messages in the two selected languages', () => {
  const th = LANGUAGES.find(l => l.id === 'th')!
  const vi_ = LANGUAGES.find(l => l.id === 'vi')!
  const ko = LANGUAGES.find(l => l.id === 'ko')!

  // 選んだ順に、空行をはさんで並べた文言
  const twoLanguages = (key: MessageKey, l1: string, l2: string) => `${MESSAGES[key][l1]}\n\n${MESSAGES[key][l2]}`

  afterEach(() => {
    vi.useRealTimers()
  })

  // langs[0] の国旗をタップして録音し、止めて /api/interpret を呼ぶ
  async function interpretWith(langs: Language[], size = MIN_INTERPRET_AUDIO_BYTES) {
    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
    renderPage(langs)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${langs[0].label}で話す` }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${langs[0].label}の録音を停止` }))
    })
  }

  async function clickSpeak() {
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    })
  }

  const alertText = () => screen.getByRole('alert').textContent

  it('input_too_large (/api/translate)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, { error: 'text too long', code: 'input_too_large' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('Good evening')
    await waitFor(() => expect(alertText()).toBe(twoLanguages('input_too_large', 'th', 'vi')))
  })

  it('service_unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(503, { error: 'x', code: 'service_unavailable' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('service_unavailable', 'th', 'vi')))
  })

  it('upstream_busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(503, { error: 'x', code: 'upstream_busy' }))
    await interpretWith([vi_, th])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('upstream_busy', 'vi', 'th')))
  })

  it('timeout (the backend 504)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(504, { error: 'x', code: 'timeout' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('timeout', 'th', 'vi')))
    expect(alertText()).not.toContain(MESSAGES.request_timeout.th)
  })

  it('tts_too_long (the frontend check and the /api/tts input_too_large)', async () => {
    setupAudioMock()
    const text = 'あ'.repeat(501)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ translatedText: text, ttsText: text })))
    await interpretWith([th, vi_])
    await clickSpeak()
    expect(alertText()).toBe(twoLanguages('tts_too_long', 'th', 'vi'))
    expect(alertText()).toContain('500')
    cleanup()
    vi.restoreAllMocks()

    setupAudioMock()
    const fetchMock2 = vi.spyOn(globalThis, 'fetch')
    fetchMock2.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock2.mockResolvedValueOnce(makeErrorResponse(400, { error: 'x', code: 'input_too_large' }))
    await interpretWith([ko, en])
    await clickSpeak()
    await waitFor(() => expect(alertText()).toBe(twoLanguages('tts_too_long', 'ko', 'en')))
  })

  it('recording_too_long (the /api/interpret 413 and the check before sending)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(413, { error: 'x', code: 'input_too_large' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('recording_too_long', 'th', 'vi')))
    cleanup()
    vi.restoreAllMocks()

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await interpretWith([th, vi_], 1_032_193)
    await waitFor(() => expect(alertText()).toBe(twoLanguages('recording_too_long', 'th', 'vi')))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('microphone_denied', async () => {
    setupMediaRecorderMock()
    setupGetUserMediaMock(true)
    renderPage([th, vi_])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thaiで話す' }))
    })
    await waitFor(() => expect(alertText()).toBe(twoLanguages('microphone_denied', 'th', 'vi')))
  })

  it('recording_start_failed (after getUserMedia, before the recording is established)', async () => {
    const Ctor = vi.fn(function () { throw new DOMException('not supported', 'NotSupportedError') }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
    Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
    Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
    setupGetUserMediaMock()
    renderPage([th, vi_])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thaiで話す' }))
    })
    await waitFor(() => expect(alertText()).toBe(twoLanguages('recording_start_failed', 'th', 'vi')))
  })

  it('microphone_no_audio (no transcript, almost no data, and 1 second or longer)', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
    renderPage([th, vi_])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thaiで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) }) })
    now += 1500
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thaiの録音を停止' }))
    })
    expect(alertText()).toBe(twoLanguages('microphone_no_audio', 'th', 'vi'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recording_failed (MediaRecorder onerror after the recording is established)', async () => {
    mockRecorder = undefined
    setupMediaRecorderMock()
    setupGetUserMediaMock()
    renderPage([th, vi_])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thaiで話す' }))
    })
    await act(async () => { (mockRecorder as unknown as { onerror: (e: unknown) => void }).onerror({}) })
    await waitFor(() => expect(alertText()).toBe(twoLanguages('recording_failed', 'th', 'vi')))
  })

  it('generic_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(502, { error: 'translation failed', code: 'upstream_error' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('generic_error', 'th', 'vi')))
  })

  it('language_unclear', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(make422Response({ error: 'language_mismatch' }))
    await interpretWith([th, vi_])
    await waitFor(() => expect(alertText()).toBe(twoLanguages('language_unclear', 'th', 'vi')))
  })

  it('request_timeout (the frontend timeout of /api/interpret and /api/translate)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => pendingUntilAborted(options))
    await interpretWith([th, vi_])
    await act(async () => { vi.advanceTimersByTime(65_000) })
    await waitFor(() => expect(alertText()).toBe(twoLanguages('request_timeout', 'th', 'vi')))
    cleanup()
    vi.restoreAllMocks()

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockImplementationOnce((_url, options) => pendingUntilAborted(options))
    await interpretWith([th, vi_])
    await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
    await editAndRetranslate('Good evening')
    await act(async () => { vi.advanceTimersByTime(30_000) })
    await waitFor(() => expect(alertText()).toBe(twoLanguages('request_timeout', 'th', 'vi')))
  })

  it('distinguishes the frontend timeout from the backend 504', async () => {
    expect(MESSAGES.request_timeout.ja).not.toBe(MESSAGES.timeout.ja)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(504, { error: 'x', code: 'timeout' }))
    await renderAndInterpret()
    await waitFor(() => expect(alertText()).toBe(jaEn('timeout')))
  })

  describe('generic error', () => {
    it('does not show the HTTP status for a status without a message (502)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(502, { error: 'translation failed', code: 'upstream_error' }))
      await renderAndInterpret()
      await waitFor(() => expect(alertText()).toBe(jaEn('generic_error')))
      expect(alertText()).not.toContain('HTTP')
      expect(alertText()).not.toContain('502')
      expect(alertText()).not.toContain('translation failed')
    })

    it('does not show the browser error when fetch rejects (/api/interpret)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await renderAndInterpret()
      await waitFor(() => expect(alertText()).toBe(jaEn('generic_error')))
      expect(alertText()).not.toContain('Failed to fetch')
    })

    it('does not show the browser error when fetch rejects (/api/translate)', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await interpretWith([th, vi_])
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
      await editAndRetranslate('Good evening')
      await waitFor(() => expect(alertText()).toBe(twoLanguages('generic_error', 'th', 'vi')))
      expect(alertText()).not.toContain('Failed to fetch')
    })

    it('shows the generic error message when the response is not JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      } as unknown as Response)
      await renderAndInterpret()
      await waitFor(() => expect(alertText()).toBe(jaEn('generic_error')))
    })
  })

  describe('console log', () => {
    it('logs the endpoint, status, and kind of error, but not the speech or the translation', async () => {
      const warn = vi.mocked(console.warn)
      const recognition = setupSpeechRecognitionMock()
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ text: '秘密の発話', translatedText: 'secret translation', backTranslation: '(秘密の逆翻訳)' })))
      fetchMock.mockResolvedValueOnce(makeErrorResponse(502, { error: 'translation failed: 秘密の原文', code: 'upstream_error' }))
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

      mockRecorder = undefined
      setupMediaRecorderMock()
      setupGetUserMediaMock()
      renderPage([ja, en])
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
      })
      act(() => { recognition.onresult?.({ results: [[{ transcript: '秘密の発話' }]] }) })
      act(() => { mockRecorder!.ondataavailable?.({ data: new Blob([AUDIO_DATA]) }) })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
      })
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument())
      await editAndRetranslate('秘密の原文')
      await waitFor(() => expect(alertText()).toBe(jaEn('generic_error')))
      await editAndRetranslate('秘密の原文その2')
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(2))

      expect(warn.mock.calls).toEqual([
        ['[GoTalk] API error', { endpoint: '/api/translate', status: 502, reason: 'upstream_error' }],
        ['[GoTalk] API error', { endpoint: '/api/translate', status: null, reason: 'TypeError' }],
      ])
      const logged = JSON.stringify(warn.mock.calls)
      for (const secret of ['秘密', 'secret', 'translation failed', 'Failed to fetch']) {
        expect(logged).not.toContain(secret)
      }
    })

    it('logs the frontend timeout', async () => {
      const warn = vi.mocked(console.warn)
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => pendingUntilAborted(options))
      await renderAndInterpret()
      await act(async () => { vi.advanceTimersByTime(65_000) })
      await waitFor(() => expect(alertText()).toBe(jaEn('request_timeout')))
      expect(warn).toHaveBeenCalledWith('[GoTalk] API error', { endpoint: '/api/interpret', status: null, reason: 'frontend_timeout' })
    })

    it('logs a code from /api/tts that does not match the format as invalid', async () => {
      const warn = vi.mocked(console.warn)
      setupAudioMock()
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockResolvedValueOnce(makeErrorResponse(502, { error: 'x', code: 'Proxy Error: 秘密' }))
      await renderAndInterpret()
      await clickSpeak()
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(warn.mock.calls).toEqual([['[GoTalk] API error', { endpoint: '/api/tts', status: 502, reason: 'invalid' }]])
    })

    it('logs the size check before sending', async () => {
      const warn = vi.mocked(console.warn)
      vi.spyOn(globalThis, 'fetch')
      await interpretWith([ja, en], 1_032_193)
      await waitFor(() => expect(alertText()).toBe(jaEn('recording_too_long')))
      expect(warn).toHaveBeenCalledWith('[GoTalk] API error', { endpoint: '/api/interpret', status: null, reason: 'recording_too_large_before_send' })
    })
  })

  describe('TTS without a message', () => {
    it('shows nothing when /api/tts fails with a network error', async () => {
      setupAudioMock()
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await renderAndInterpret()
      await clickSpeak()
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(vi.mocked(console.warn)).toHaveBeenCalledWith('[GoTalk] API error', { endpoint: '/api/tts', status: null, reason: 'TypeError' })
    })

    it('shows nothing when /api/tts returns a status without a message (502)', async () => {
      setupAudioMock()
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
      fetchMock.mockResolvedValueOnce(makeErrorResponse(502, { error: 'tts failed', code: 'upstream_error' }))
      await renderAndInterpret()
      await clickSpeak()
      await waitFor(() => expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
