import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { LANGUAGES } from '../languages'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'
import { resetKeptMicForTest } from '../audio/keptMic'

// 通訳の画面の診断の表示（docs/testing.md の「診断の表示（?diag）」）と、通訳の画面が付ける listener

const [ja, en] = LANGUAGES
const PAGE_EVENTS = ['visibilitychange', 'pagehide', 'pageshow']

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let docAdd: ReturnType<typeof vi.spyOn>
let winAdd: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  setupAudioContext()
  setupAnimationFrame()
  docAdd = vi.spyOn(document, 'addEventListener')
  winAdd = vi.spyOn(window, 'addEventListener')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
  } as unknown as Response)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

function renderPage(showDiagnostics?: boolean) {
  return render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} showDiagnostics={showDiagnostics} />)
}

const pageListenerTypes = () => [
  ...docAdd.mock.calls.map((c: unknown[]) => String(c[0])),
  ...winAdd.mock.calls.map((c: unknown[]) => String(c[0])),
].filter(t => PAGE_EVENTS.includes(t)).sort()

const handlerKeys = (obj: object) => Object.keys(obj).filter(k => k.startsWith('on') && (obj as Record<string, unknown>)[k]).sort()

function countTrackListeners(stream: FakeStream) {
  const types: string[] = []
  stream.tracks.forEach(track => {
    const original = track.addEventListener
    track.addEventListener = (type: string, listener: () => void) => { types.push(type); original(type, listener) }
  })
  return types
}

async function tapJa() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
}

async function startRecording(index: number, stream = makeFakeStream()) {
  await tapJa()
  await act(async () => { await gum.calls[index].resolve(stream) })
  return stream
}

async function stopAndFinish(index: number, chunks: string[]) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
  await act(async () => {
    chunks.forEach(c => recorders.instances[index].ondataavailable?.({ data: new Blob([c]) }))
    recorders.instances[index].onstop?.()
  })
  await act(async () => { await Promise.resolve() })
}

function mockClipboard() {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { writes.push(text) }) }, configurable: true })
  return writes
}

async function copyJson(): Promise<Record<string, unknown> & { diagnostics: Record<string, unknown> }> {
  const writes = mockClipboard()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return JSON.parse(writes.at(-1)!)
}

describe('InterpreterPage without ?diag', () => {
  it('does not render the panel', () => {
    renderPage()
    expect(screen.queryByRole('region', { name: '実験の診断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'コピー' })).toBeNull()
  })

  it('adds only the listeners of the current version', async () => {
    renderPage()
    expect(pageListenerTypes()).toEqual(['pagehide', 'pageshow', 'visibilitychange'])
    const stream = makeFakeStream()
    const trackTypes = countTrackListeners(stream)
    await startRecording(0, stream)
    expect(trackTypes).toEqual(['ended'])
    expect(handlerKeys(recorders.instances[0])).toEqual(['ondataavailable', 'onerror', 'onstop'])
    expect(handlerKeys(recognitions.instances[0])).toEqual(['onend', 'onerror', 'onresult'])
  })
})

describe('InterpreterPage with ?diag (diagnostics panel)', () => {
  it('renders the panel', () => {
    renderPage(true)
    expect(screen.getByRole('region', { name: '実験の診断' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'コピー' })).toBeInTheDocument()
  })

  it('changes the view only when 更新 is pressed', async () => {
    renderPage(true)
    expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('diagnostics-snapshot')).toHaveTextContent('録音の記録はありません')
    await startRecording(0)
    await stopAndFinish(0, ['abc'])
    // 録音の後も、押すまでは変わらない
    expect(screen.getByTestId('diagnostics-snapshot')).toHaveTextContent('録音の記録はありません')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    const view = screen.getByTestId('diagnostics-snapshot')
    expect(view).toHaveTextContent('セッション 1：止めた理由=user')
    expect(view).toHaveTextContent('bytes=3')
    expect(view).toHaveTextContent('track=live/enabled/unmuted')
    // 次の録音（マイクを使い回すので getUserMedia は呼ばない）の後も、押すまでは前のスナップショットのまま
    await tapJa()
    await stopAndFinish(1, ['de'])
    expect(screen.getByTestId('diagnostics-snapshot')).not.toHaveTextContent('セッション 2')
  })

  it('copies the latest JSON with sessions, events and keptMic, without the recognized text', async () => {
    renderPage(true)
    await startRecording(0)
    await act(async () => { recognitions.instances[0].onresult?.({ results: [[{ transcript: '聞かれたくない本文' }]] }) })
    await stopAndFinish(0, ['abcd'])
    const json = await copyJson()
    expect(json.kind).toBe('audioSession')
    expect(typeof json.takenAt).toBe('string')
    expect(json).not.toHaveProperty('effective')
    expect(Object.keys(json.diagnostics).sort()).toEqual(['events', 'keptMic', 'sessions'])
    const diagnostics = json.diagnostics as { sessions: { recorder: { bytes: number }; recognition: { chars: number } }[]; keptMic: unknown }
    expect(diagnostics.sessions[0].recorder.bytes).toBe(4)
    expect(diagnostics.sessions[0].recognition.chars).toBe(9)
    expect(diagnostics.keptMic).toEqual({ getUserMediaCalls: 1, endedEvents: [] })
    const text = JSON.stringify(json)
    expect(text).not.toContain('聞かれたくない本文')
    expect(text).not.toContain('こんにちは')
    expect(screen.getByRole('status')).toHaveTextContent('コピーしました')
  })

  it('shows the JSON in a textarea when the clipboard fails', async () => {
    renderPage(true)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const textarea = screen.getByRole('textbox', { name: '診断の JSON' }) as HTMLTextAreaElement
    expect(JSON.parse(textarea.value).kind).toBe('audioSession')
    expect(screen.getByRole('status')).toHaveTextContent('コピーできませんでした')
  })

  it('disables the buttons while starting, recording and stopping', async () => {
    renderPage(true)
    const refresh = () => screen.getByRole('button', { name: '更新' })
    const copy = () => screen.getByRole('button', { name: 'コピー' })
    await tapJa()
    // starting
    expect(refresh()).toBeDisabled()
    expect(copy()).toBeDisabled()
    await act(async () => { await gum.calls[0].resolve() })
    // recording
    expect(refresh()).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    // stopping
    expect(refresh()).toBeDisabled()
    expect(copy()).toBeDisabled()
    await act(async () => { recorders.instances[0].onstop?.() })
    await act(async () => { await Promise.resolve() })
    expect(refresh()).toBeEnabled()
    expect(copy()).toBeEnabled()
  })
})
