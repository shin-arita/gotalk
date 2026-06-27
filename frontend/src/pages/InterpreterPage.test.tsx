import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'

// --- Shared fixtures ---

const [ja, en] = LANGUAGES

function renderPage(
  selectedLanguages: Language[] = [ja, en],
  onBack = vi.fn(),
  pendingAudio?: Blob,
) {
  return render(
    <InterpreterPage
      selectedLanguages={selectedLanguages}
      onBack={onBack}
      pendingAudio={pendingAudio}
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

interface MockAudioInstance {
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  onerror: (() => void) | null
}

let mockAudioInstance: MockAudioInstance | null = null

function setupAudioMock() {
  mockAudioInstance = null
  const instance: MockAudioInstance = {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    onended: null,
    onerror: null,
  }
  Object.defineProperty(globalThis, 'Audio', {
    value: vi.fn(function () { mockAudioInstance = instance; return instance }),
    writable: true,
    configurable: true,
  })
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:fake')
  globalThis.URL.revokeObjectURL = vi.fn()
  return instance
}

function makeAudioOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' })),
  } as unknown as Response
}

// --- Lifecycle ---

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ============================================================
// Language Mismatch — interpret API
// ============================================================

describe('InterpreterPage language mismatch (interpret API)', () => {
  it('shows mismatch messages for all selected languages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    const msg = screen.getByRole('alert').textContent ?? ''
    expect(msg).toContain('言語不明、もう一度お話ください')
    expect(msg).toContain('Language unclear. Please speak again.')
  })

  it('clears translated text on mismatch (speak button hidden)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '発声する' })).not.toBeInTheDocument()
  })

  it('resets status to idle after mismatch (speak button hidden)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByText('おはようございます', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
  })

  it('shows back translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ backTranslation: '(Good morning JP)' })),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() => expect(screen.getByText('(Good morning JP)')).toBeInTheDocument())
  })

  it('shows speak button after successful translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )
  })

  it('shows error message on HTTP 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(make500Response())
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain('HTTP 500')
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
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )
  })

  it('clicking speak POSTs to /api/tts with ttsText from response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは', ttsText: 'Konnichiwa' })))
    fetchMock.mockResolvedValueOnce(makeAudioOkResponse())

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    })
  })

  it('speak button is disabled while TTS fetch is in progress', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockReturnValueOnce(new Promise(() => {}))

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))

    await waitFor(() => expect(mockAudioInstance).not.toBeNull())
    act(() => { mockAudioInstance!.onended?.() })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  it('speak button re-enables after TTS fetch error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(make500Response())

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
  it('shows HTTP 500 error on retranslation failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(makeOkResponse(makeInterpretResponse()))
    fetchMock.mockResolvedValueOnce(make500Response())

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    expect(screen.getByRole('alert').textContent).toContain('HTTP 500')
  })

  it('retains previous translatedText and keeps speak button accessible after 500', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは' })),
    )
    fetchMock.mockResolvedValueOnce(make500Response())

    renderPage([ja, en], vi.fn(), new Blob(['audio']))
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
    expect(
      screen.getByText('こんにちは', { selector: '.translation-card__text' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
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
    let mockRec: { ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; state: string } | undefined
    const mock = {
      ondataavailable: null as typeof mockRec extends undefined ? null : ((e: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      state: 'inactive',
    }
    const Ctor = vi.fn(function () { mock.state = 'recording'; mockRec = mock as typeof mockRec; return mock }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
    Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
    mock.stop = vi.fn(function () { mock.state = 'inactive'; mock.onstop?.() })
    Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
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
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
      writable: true, configurable: true,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは' })),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRec2!.ondataavailable?.({ data: new Blob(['audio']) }) })
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

function setupGetUserMediaMock(rejects = false) {
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] }
  const getUserMedia = rejects
    ? vi.fn().mockRejectedValue(new Error('Permission denied'))
    : vi.fn().mockResolvedValue(fakeStream)
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
  return getUserMedia
}

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
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) }) })
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
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) }) })
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
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) }) })
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
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) }) })
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
    expect(screen.getByRole('alert').textContent).toContain('マイクへのアクセスが許可されていません')
  })

  it('translation result and history are added after flag-tap recording', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ text: 'こんにちは', translatedText: 'Hello' })),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' }))
    })
    act(() => { mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' }))
    })

    await waitFor(() =>
      expect(screen.getByText('Hello', { selector: '.translation-card__text' })).toBeInTheDocument(),
    )
    expect(document.querySelector('.history-item__source')?.textContent).toBe('こんにちは')
  })
})
