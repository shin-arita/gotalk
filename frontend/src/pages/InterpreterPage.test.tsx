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
  backTranslation: string
  sourceLanguage: string
  targetLanguage: string
}> = {}) {
  return {
    text: 'Hello',
    translatedText: 'こんにちは',
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

// --- SpeechSynthesis mock ---

class MockUtterance {
  lang = ''
  text: string
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: Partial<SpeechSynthesisErrorEvent>) => void) | null = null
  constructor(text: string) { this.text = text }
}

let lastUtterance: MockUtterance | null = null

const speechSynthMock = {
  speak: vi.fn((u: MockUtterance) => { lastUtterance = u }),
  cancel: vi.fn(),
}

function setupSpeechSynthesis() {
  lastUtterance = null
  speechSynthMock.speak.mockClear()
  speechSynthMock.cancel.mockClear()
  Object.defineProperty(window, 'speechSynthesis', {
    value: speechSynthMock,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: MockUtterance,
    writable: true,
    configurable: true,
  })
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

  it('resets status to idle — mic button is re-enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      make422Response({ error: 'language_mismatch' }),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '話す' })).not.toBeDisabled()
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
  it('shows recognized text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ text: 'Good morning' })),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByText('Good morning', { selector: '.source-card__text' })).toBeInTheDocument(),
    )
  })

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
    setupSpeechSynthesis()
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

  it('does not show expand button when there are 5 or fewer entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(document.querySelectorAll('.history-item')).toHaveLength(1),
    )
    expect(
      screen.queryByRole('button', { name: '履歴をすべて表示' }),
    ).not.toBeInTheDocument()
  })

  it('shows expand button when more than 5 entries exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    // Wait for initial interpretation to complete
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
      // Wait for retranslation to complete (edit button re-enables when status returns to 'ready')
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '編集' })).not.toBeDisabled(),
      )
    }

    expect(
      screen.getByRole('button', { name: '履歴をすべて表示' }),
    ).toBeInTheDocument()
  })

  it('expand button shows all entries; collapse button hides extras', async () => {
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

    // 5 visible, 1 hidden
    expect(document.querySelectorAll('.history-item')).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: '履歴をすべて表示' }))
    expect(document.querySelectorAll('.history-item')).toHaveLength(6)

    fireEvent.click(screen.getByRole('button', { name: '履歴を閉じる' }))
    expect(document.querySelectorAll('.history-item')).toHaveLength(5)
  })
})

// ============================================================
// Speech Synthesis UI
// ============================================================

describe('InterpreterPage speech synthesis UI', () => {
  beforeEach(() => {
    setupSpeechSynthesis()
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

  it('clicking speak calls speechSynthesis.speak with correct text and lang', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({ translatedText: 'こんにちは', targetLanguage: 'ja' })),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))

    expect(speechSynthMock.speak).toHaveBeenCalledOnce()
    expect(lastUtterance?.text).toBe('こんにちは')
    expect(lastUtterance?.lang).toBe('ja-JP')
  })

  it('speak button is disabled while speaking', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    expect(screen.getByRole('button', { name: '発声する' })).toBeDisabled()
  })

  it('speak button re-enables after TTS onend', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    act(() => { lastUtterance!.onend?.() })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  it('speak button re-enables after TTS onerror', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    act(() => { lastUtterance!.onerror?.({ error: 'network' } as Partial<SpeechSynthesisErrorEvent>) })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
  })

  it('fallback timer resets status to ready after TTS_FALLBACK_MS (3000 ms)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    expect(screen.getByRole('button', { name: '発声する' })).toBeDisabled()

    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()

    vi.useRealTimers()
  })

  it('does not call speechSynthesis when it is unavailable', async () => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en], vi.fn(), new Blob(['audio']))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '発声する' })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '発声する' }))
    expect(speechSynthMock.speak).not.toHaveBeenCalled()
  })
})

// ============================================================
// MediaRecorder mock helpers (recording / mic-reject tests)
// ============================================================

interface MockRecorderInstance {
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  state: string
}

let mockRecorder: MockRecorderInstance | undefined
let mockGetUserMedia: ReturnType<typeof vi.fn>

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

  Object.defineProperty(globalThis, 'MediaRecorder', {
    value: Ctor,
    writable: true,
    configurable: true,
  })

  return mock
}

function setupGetUserMediaMock(rejects = false) {
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] }
  const getUserMedia = rejects
    ? vi.fn().mockRejectedValue(new Error('Permission denied'))
    : vi.fn().mockResolvedValue(fakeStream)

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia },
    writable: true,
    configurable: true,
  })

  return getUserMedia
}

// ============================================================
// Translate API 500 (retranslation error)
// ============================================================

describe('InterpreterPage translate API 500', () => {
  it('shows HTTP 500 error and re-enables mic button', async () => {
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
    expect(screen.getByRole('button', { name: '話す' })).not.toBeDisabled()
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
// Recording start/stop
// ============================================================

describe('InterpreterPage recording start/stop', () => {
  beforeEach(() => {
    mockRecorder = undefined
    setupMediaRecorderMock()
    mockGetUserMedia = setupGetUserMediaMock()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).MediaRecorder
  })

  it('calls getUserMedia({ audio: true }) and enters recording state on mic press', async () => {
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '話す' }))
    })

    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(screen.getByRole('button', { name: '停止して翻訳' })).toBeInTheDocument()
  })

  it('pressing stop calls MediaRecorder.stop', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse()),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '話す' }))
    })
    const stopSpy = mockRecorder!.stop

    act(() => {
      mockRecorder!.ondataavailable?.({ data: new Blob(['audio']) })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止して翻訳' }))
    })

    expect(stopSpy).toHaveBeenCalled()
  })

  it('calls /api/interpret after ondataavailable + onstop, then shows translation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeOkResponse(makeInterpretResponse({
        text: 'Spoken text',
        translatedText: '話されたテキスト',
        backTranslation: '(Spoken text)',
      })),
    )

    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '話す' }))
    })
    act(() => {
      mockRecorder!.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止して翻訳' }))
    })

    await waitFor(() =>
      expect(
        screen.getByText('Spoken text', { selector: '.source-card__text' }),
      ).toBeInTheDocument(),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/interpret',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(
      screen.getByText('話されたテキスト', { selector: '.translation-card__text' }),
    ).toBeInTheDocument()
    expect(screen.getByText('(Spoken text)')).toBeInTheDocument()
  })
})

// ============================================================
// Mic permission reject
// ============================================================

describe('InterpreterPage mic permission reject', () => {
  beforeEach(() => {
    setupMediaRecorderMock()
    mockGetUserMedia = setupGetUserMediaMock(true)
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).MediaRecorder
  })

  it('shows mic access denied error after getUserMedia rejects', async () => {
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '話す' }))
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain(
      'マイクへのアクセスが許可されていません',
    )
  })

  it('resets to idle and re-enables mic button after permission reject', async () => {
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '話す' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '話す' })).not.toBeDisabled(),
    )
  })
})
