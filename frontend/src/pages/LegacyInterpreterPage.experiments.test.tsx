import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import LegacyInterpreterPage from './LegacyInterpreterPage'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// legacy（PR #26 の前の通訳の画面）の実験の記録と、足していないもの（docs/testing.md の「実験のスイッチ」）

const hookSpies = vi.hoisted(() => ({ useAudioSession: vi.fn(), createAudioSession: vi.fn() }))

vi.mock('../hooks/useAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAudioSession')>()
  return {
    ...actual,
    useAudioSession: (...args: Parameters<typeof actual.useAudioSession>) => { hookSpies.useAudioSession(); return actual.useAudioSession(...args) },
    createAudioSession: (...args: Parameters<typeof actual.createAudioSession>) => { hookSpies.createAudioSession(); return actual.createAudioSession(...args) },
  }
})

const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let contexts: ReturnType<typeof setupAudioContext>
let frames: ReturnType<typeof setupAnimationFrame>

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  contexts = setupAudioContext()
  frames = setupAnimationFrame()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
  } as unknown as Response)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  hookSpies.useAudioSession.mockClear()
  hookSpies.createAudioSession.mockClear()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

function renderLegacy(experiment?: ExperimentConfig) {
  return render(<LegacyInterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
}

// track の状態の getter と addEventListener を数える
function watchStream(stream: FakeStream) {
  const getters = stream.tracks.flatMap(track => (['readyState', 'enabled', 'muted'] as const).map(key => {
    const value = track[key]
    const getter = vi.fn(() => value)
    Object.defineProperty(track, key, { get: getter, configurable: true })
    return getter
  }))
  const addListener = vi.fn()
  stream.tracks.forEach(track => { track.addEventListener = addListener })
  return { getters, addListener }
}

async function recordOnce(index: number, chunks: string[], stream = makeFakeStream()) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
  await act(async () => { await gum.calls[index].resolve(stream) })
  const recorder = recorders.instances[index]
  recorder.mimeType = 'audio/webm'
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
  await act(async () => {
    chunks.forEach(c => recorder.ondataavailable?.({ data: new Blob([c]) }))
    recorder.onstop?.()
  })
  // 翻訳の結果が出るまで待つ
  await act(async () => { await Promise.resolve() })
}

describe('LegacyInterpreterPage with exp=legacy', () => {
  it('records the ondataavailable sizes, the final Blob size, the mimeType and the start and stop times', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    await recordOnce(0, ['ab', '', 'cde'])
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { copied = text }) }, configurable: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const json = JSON.parse(copied)
    expect(json.kind).toBe('legacy')
    expect(json.effective).toEqual(['legacy'])
    expect(json.recordings).toHaveLength(1)
    const [rec] = json.recordings
    expect(rec.dataSizes).toEqual([2, 0, 3])
    expect(rec.blobSize).toBe(5)
    expect(rec.mimeType).toBe('')
    expect(rec.startCalledAt).toEqual(expect.any(Number))
    expect(rec.stopCalledAt).toBeGreaterThanOrEqual(rec.startCalledAt)
    // 認識した本文や翻訳の結果は入らない
    expect(copied).not.toContain('Hello')
    expect(copied).not.toContain('こんにちは')
  })

  it('shows the snapshot only when 更新 is pressed', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    expect(screen.queryByTestId('experiment-snapshot')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('録音の記録はありません')
    await recordOnce(0, ['abcd'])
    // 録音の後も、押すまでは変わらない
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('録音の記録はありません')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('ondataavailable=1回 [4]、Blob=4')
  })

  it('disables the buttons while recording', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[0].resolve() })
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'コピー' })).toBeDisabled()
  })

  it('does not use useAudioSession', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    await recordOnce(0, ['ab'])
    expect(hookSpies.useAudioSession).not.toHaveBeenCalled()
    expect(hookSpies.createAudioSession).not.toHaveBeenCalled()
  })

  it('adds no track reads, no track listeners and no page listeners', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    const winAdd = vi.spyOn(window, 'addEventListener')
    renderLegacy(readExperimentConfig('?exp=legacy'))
    const stream = makeFakeStream()
    const { getters, addListener } = watchStream(stream)
    await recordOnce(0, ['ab'], stream)
    getters.forEach(g => expect(g).not.toHaveBeenCalled())
    expect(addListener).not.toHaveBeenCalled()
    const pageTypes = ['visibilitychange', 'pagehide', 'pageshow']
    expect(docAdd.mock.calls.filter(c => pageTypes.includes(String(c[0])))).toEqual([])
    expect(winAdd.mock.calls.filter(c => pageTypes.includes(String(c[0])))).toEqual([])
  })
})

describe('LegacyInterpreterPage without exp', () => {
  it('does not render the panel', () => {
    renderLegacy()
    expect(screen.queryByRole('region', { name: '実験の診断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
  })
})

// 07f06f0 のテストで通っていなかった、PR #26 の前の動き（legacy の部品が、そのまま動くことを確かめる）
describe('LegacyInterpreterPage behaviors of 07f06f0', () => {
  it('moves the ripples with the level meter and closes the AudioContext on the stop', async () => {
    renderLegacy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[0].resolve() })
    act(() => { frames.frame(16) })
    act(() => { frames.frame(766) })
    const ripples = document.querySelectorAll<HTMLDivElement>('.flag-ripple')
    expect(ripples).toHaveLength(3)
    expect(ripples[0].style.transform).toBe('scale(0.5)')
    expect(Number(ripples[0].style.opacity)).toBeGreaterThan(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    expect(frames.cancel).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('shows the recognized text and restarts the recognition only while recording', async () => {
    renderLegacy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[0].resolve() })
    const recognition = recognitions.instances[0]
    act(() => { recognition.onresult?.({ results: [[{ transcript: 'こんに' }], [{ transcript: 'ちは' }]] }) })
    expect(screen.getByText('こんにちは')).toBeInTheDocument()
    recognition.onerror?.()
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(2)
    recognition.start.mockImplementationOnce(() => { throw new Error('busy') })
    expect(() => recognition.onend?.()).not.toThrow()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    expect(recognition.stop).toHaveBeenCalledTimes(1)
    recognition.onend?.()
    expect(recognition.start).toHaveBeenCalledTimes(3)
  })

  it('closes everything when the screen goes away while recording', async () => {
    const { unmount } = renderLegacy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    const stream = await act(async () => gum.calls[0].resolve())
    unmount()
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.tracks[0].stop).toHaveBeenCalled()
    expect(recognitions.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(frames.cancel).toHaveBeenCalledTimes(1)
    expect(contexts.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('shows microphone_denied when getUserMedia fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderLegacy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    await act(async () => { await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Japaneseで話す' })).toBeEnabled()
  })

  it('keeps only the latest ten recordings in the experiment record', async () => {
    renderLegacy(readExperimentConfig('?exp=legacy'))
    for (let i = 0; i < 11; i++) await recordOnce(i, [String(i).padStart(i + 1, 'x')])
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { copied = text }) }, configurable: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const sizes = JSON.parse(copied).recordings.map((r: { blobSize: number }) => r.blobSize)
    expect(sizes).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
