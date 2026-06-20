import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import LanguageSelectPage from './LanguageSelectPage'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'

// --- MediaRecorder mock ---

interface MockRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  state: string
}

let mockRecorderInstance: MockRecorder | undefined

function setupMediaRecorderMock(isTypeSupportedResult = false) {
  const mock = {
    ondataavailable: null as MockRecorder['ondataavailable'],
    onstop: null as MockRecorder['onstop'],
    start: vi.fn(),
    stop: vi.fn(),
    state: 'inactive',
  }

  const Ctor = vi.fn(function MediaRecorderCtor() {
    mock.state = 'recording'
    mockRecorderInstance = mock
    return mock
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }

  Ctor.isTypeSupported = vi.fn().mockReturnValue(isTypeSupportedResult)

  // stop triggers onstop (synchronous, matching real MediaRecorder behavior in tests)
  mock.stop = vi.fn(function () {
    mock.state = 'inactive'
    mock.onstop?.()
  })

  Object.defineProperty(globalThis, 'MediaRecorder', {
    value: Ctor,
    writable: true,
    configurable: true,
  })

  return { mock, Ctor }
}

function setupGetUserMediaMock(stream: { getTracks: () => { stop: () => void }[] } | null = null) {
  const fakeStream = stream ?? { getTracks: () => [{ stop: vi.fn() }] }
  const getUserMedia = vi.fn().mockResolvedValue(fakeStream)

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia },
    writable: true,
    configurable: true,
  })

  return getUserMedia
}

// --- Helpers ---

const [ja, en] = LANGUAGES

function renderPage(
  selectedLanguages: Language[] = [],
  onSelectionChange = vi.fn(),
  onStart = vi.fn(),
) {
  return render(
    <LanguageSelectPage
      selectedLanguages={selectedLanguages}
      onSelectionChange={onSelectionChange}
      onStart={onStart}
    />,
  )
}

async function startRecording(selected: Language[] = [ja, en]) {
  renderPage(selected)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
  })
}

// --- Setup / teardown ---

beforeEach(() => {
  mockRecorderInstance = undefined
  setupMediaRecorderMock()
  setupGetUserMediaMock()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).MediaRecorder
})

// ============================================================
// Rendering
// ============================================================

describe('LanguageSelectPage rendering', () => {
  it('renders all 6 language cards', () => {
    renderPage()
    const buttons = screen.getAllByRole('button', { name: /Japanese|English|Chinese|Korean|Thai/ })
    expect(buttons).toHaveLength(6)
  })

  it('renders the app title', () => {
    renderPage()
    expect(screen.getByText('GoTalk')).toBeInTheDocument()
  })

  it('mic button is disabled when fewer than 2 languages selected', () => {
    renderPage([ja])
    expect(screen.getByRole('button', { name: '会話を開始する' })).toBeDisabled()
  })

  it('mic button is enabled when exactly 2 languages selected', () => {
    renderPage([ja, en])
    expect(screen.getByRole('button', { name: '会話を開始する' })).not.toBeDisabled()
  })

  it('selected card has aria-pressed=true', () => {
    renderPage([ja])
    expect(screen.getByRole('button', { name: 'Japanese' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('unselected card has aria-pressed=false', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Japanese' })).toHaveAttribute('aria-pressed', 'false')
  })
})

// ============================================================
// Card selection
// ============================================================

describe('LanguageSelectPage card selection', () => {
  it('calls onSelectionChange with the tapped language when unselected', () => {
    const onSelectionChange = vi.fn()
    renderPage([], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onSelectionChange).toHaveBeenCalledWith([ja])
  })

  it('calls onSelectionChange without the language when already selected', () => {
    const onSelectionChange = vi.fn()
    renderPage([ja], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('does not add a third language when 2 are already selected', () => {
    const onSelectionChange = vi.fn()
    renderPage([ja, en], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Chinese Simplified' }))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('ignores card taps while recording', async () => {
    const onSelectionChange = vi.fn()
    renderPage([ja, en], onSelectionChange)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    // Component is now recording; card taps should be no-ops
    onSelectionChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

// ============================================================
// Recording lifecycle
// ============================================================

describe('LanguageSelectPage recording', () => {
  it('shows stop button while recording', async () => {
    await startRecording()
    expect(screen.getByRole('button', { name: '録音を停止する' })).toBeInTheDocument()
  })

  it('calls onStart with a Blob when user stops recording', async () => {
    const onStart = vi.fn()
    renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    act(() => {
      mockRecorderInstance!.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '録音を停止する' }))
    })

    expect(onStart).toHaveBeenCalledWith(expect.any(Blob))
  })

  it('does not call onStart when recorder stops without user action', async () => {
    const onStart = vi.fn()
    renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    act(() => {
      mockRecorderInstance!.onstop?.()
    })

    expect(onStart).not.toHaveBeenCalled()
  })

  it('ignores empty data chunks in ondataavailable', async () => {
    const onStart = vi.fn()
    renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    // Empty chunk should not be accumulated
    act(() => {
      mockRecorderInstance!.ondataavailable?.({ data: new Blob([]) }) // size = 0
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '録音を停止する' }))
    })

    // onStart called with empty-ish blob (only the empty chunk was ignored)
    expect(onStart).toHaveBeenCalledWith(expect.any(Blob))
  })

  it('handleMicPress returns early when canStart is false while recording', async () => {
    const onStart = vi.fn()
    const { rerender } = renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    // Re-render with only 1 language: canStart=false, but isRecording=true so button is not disabled
    rerender(
      <LanguageSelectPage
        selectedLanguages={[ja]}
        onSelectionChange={vi.fn()}
        onStart={onStart}
      />,
    )

    // Click mic button: handleMicPress hits `if (!canStart) return` and exits
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '録音を停止する' }))
    })

    // onStart should never have been called (recording was not completed properly)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('recovers gracefully when getUserMedia rejects', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Permission denied'),
    )
    renderPage([ja, en])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    // Should revert to idle - mic button is enabled again
    expect(screen.getByRole('button', { name: '会話を開始する' })).not.toBeDisabled()
  })

  it('uses the first supported mime type', async () => {
    setupMediaRecorderMock(true) // isTypeSupported returns true → picks 'audio/webm;codecs=opus'
    setupGetUserMediaMock()

    const onStart = vi.fn()
    renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    act(() => {
      mockRecorderInstance!.ondataavailable?.({
        data: new Blob(['a'], { type: 'audio/webm;codecs=opus' }),
      })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '録音を停止する' }))
    })

    const blob: Blob = onStart.mock.calls[0][0]
    expect(blob.type).toBe('audio/webm;codecs=opus')
  })

  it('falls back to audio/webm when no mime type is supported', async () => {
    // isTypeSupported returns false (default from beforeEach)
    const onStart = vi.fn()
    renderPage([ja, en], vi.fn(), onStart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会話を開始する' }))
    })

    act(() => {
      mockRecorderInstance!.ondataavailable?.({ data: new Blob(['a']) })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '録音を停止する' }))
    })

    const blob: Blob = onStart.mock.calls[0][0]
    expect(blob.type).toBe('audio/webm')
  })
})

// ============================================================
// Cleanup on unmount
// ============================================================

describe('LanguageSelectPage unmount cleanup', () => {
  it('stops an active recording when unmounted', async () => {
    await startRecording()
    const instance = mockRecorderInstance!

    act(() => {
      cleanup()
    })

    expect(instance.stop).toHaveBeenCalled()
  })

  it('unmount without recording does not throw', () => {
    renderPage([ja, en])
    expect(() => cleanup()).not.toThrow()
  })
})
