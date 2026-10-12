import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { DEFAULT_EXPERIMENT_CONFIG, readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import {
  AUDIO_GLOBALS, makeFakeStream, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition, setVisibility,
} from '../test/audioMocks'
import type { FakeStream } from '../test/audioMocks'

// 通訳の画面の、切り分けの実験のスイッチと診断の表示（docs/testing.md の「実験のスイッチ」）

const hookSpy = vi.hoisted(() => ({ configs: [] as unknown[] }))

vi.mock('../hooks/useAudioSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAudioSession')>()
  return {
    ...actual,
    useAudioSession: (...args: Parameters<typeof actual.useAudioSession>) => {
      hookSpy.configs.push(args[1])
      return actual.useAudioSession(...args)
    },
  }
})

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
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  setupAudioContext()
  setupAnimationFrame()
  hookSpy.configs = []
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

function renderPage(experiment?: ExperimentConfig) {
  return render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={experiment} />)
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

async function copyJson(): Promise<Record<string, unknown> & { diagnostics: Record<string, never> }> {
  const writes = mockClipboard()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return JSON.parse(writes.at(-1)!)
}

describe('InterpreterPage without exp', () => {
  it('does not render the panel and passes the default config to the hook', () => {
    renderPage()
    expect(screen.queryByRole('region', { name: '実験の診断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
    expect(hookSpy.configs[0]).toBe(DEFAULT_EXPERIMENT_CONFIG)
    expect((hookSpy.configs[0] as ExperimentConfig).enabled).toBe(false)
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

describe('InterpreterPage with exp (diagnostics panel)', () => {
  it('passes the config to the hook and renders the panel', () => {
    const config = readExperimentConfig('?exp=')
    renderPage(config)
    expect(hookSpy.configs[0]).toBe(config)
    expect(screen.getByRole('region', { name: '実験の診断' })).toHaveTextContent('（スイッチなし）')
  })

  it('shows the switches, the unknown names and the inactive names', () => {
    renderPage(readExperimentConfig('?exp=norecog,legacyrecog,typo'))
    const panel = screen.getByRole('region', { name: '実験の診断' })
    expect(panel).toHaveTextContent('実験：norecog')
    expect(panel).toHaveTextContent('知らない名前：typo')
    expect(panel).toHaveTextContent('効いていない：legacyrecog（norecog が優先）')
  })

  it('changes the view only when 更新 is pressed', async () => {
    renderPage(readExperimentConfig('?exp='))
    expect(screen.queryByTestId('experiment-snapshot')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('録音の記録はありません')
    await startRecording(0)
    await stopAndFinish(0, ['abc'])
    // 録音の後も、押すまでは変わらない
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('録音の記録はありません')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
    const view = screen.getByTestId('experiment-snapshot')
    expect(view).toHaveTextContent('セッション 1：止めた理由=user')
    expect(view).toHaveTextContent('ondataavailable=1回 [3]、Blob=3')
    expect(view).toHaveTextContent('track=live/enabled/unmuted')
    // 次の録音の後も、押すまでは前のスナップショットのまま
    await startRecording(1)
    await stopAndFinish(1, ['de'])
    expect(screen.getByTestId('experiment-snapshot')).not.toHaveTextContent('セッション 2')
  })

  it('copies the latest JSON without the recognized text', async () => {
    renderPage(readExperimentConfig('?exp='))
    await startRecording(0)
    await act(async () => { recognitions.instances[0].onresult?.({ results: [[{ transcript: '聞かれたくない本文' }]] }) })
    await stopAndFinish(0, ['abcd'])
    const json = await copyJson()
    expect(json.kind).toBe('audioSession')
    const text = JSON.stringify(json)
    expect(text).not.toContain('聞かれたくない本文')
    expect(text).not.toContain('こんにちは')
    const experiment = json.diagnostics.experiment as unknown as { sessions: { recorder: { blobSize: number }; recognition: { events: { type: string; chars?: number }[] } }[] }
    expect(experiment.sessions[0].recorder.blobSize).toBe(4)
    expect(experiment.sessions[0].recognition.events.find(e => e.type === 'result')?.chars).toBe(9)
    expect(screen.getByRole('status')).toHaveTextContent('コピーしました')
  })

  it('shows the JSON in a textarea when the clipboard fails', async () => {
    renderPage(readExperimentConfig('?exp='))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const textarea = screen.getByRole('textbox', { name: '診断の JSON' }) as HTMLTextAreaElement
    expect(JSON.parse(textarea.value).kind).toBe('audioSession')
    expect(screen.getByRole('status')).toHaveTextContent('コピーできませんでした')
  })

  it('disables the buttons while starting, recording and stopping', async () => {
    renderPage(readExperimentConfig('?exp='))
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

describe('InterpreterPage experiment switches', () => {
  it('norecog: does not create the recognition', async () => {
    renderPage(readExperimentConfig('?exp=norecog'))
    await startRecording(0)
    expect(recognitions.Ctor).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Japaneseの録音を停止' })).toBeInTheDocument()
  })

  it('nolifecycle: adds no page listeners and does not abort on hidden', async () => {
    renderPage(readExperimentConfig('?exp=nolifecycle'))
    expect(pageListenerTypes()).toEqual([])
    await startRecording(0)
    act(() => { setVisibility('hidden') })
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Japaneseの録音を停止' })).toBeInTheDocument()
  })

  it('nolifecycle and trace: adds record-only listeners that do nothing else', async () => {
    renderPage(readExperimentConfig('?exp=nolifecycle,trace'))
    expect(pageListenerTypes()).toEqual(['pagehide', 'pageshow', 'visibilitychange'])
    await startRecording(0)
    act(() => { setVisibility('hidden') })
    act(() => { window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true })) })
    // 中断の片付けをしない（録音を続ける）
    expect(recorders.instances[0].stop).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Japaneseの録音を停止' })).toBeInTheDocument()
    act(() => { setVisibility('visible') })
    act(() => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })) })
    await stopAndFinish(0, ['ab'])
    const json = await copyJson()
    const experiment = json.diagnostics.experiment as unknown as { traceListenerOnly: boolean; pageEvents: { type: string; visibilityState: string; persisted?: boolean }[] }
    expect(experiment.traceListenerOnly).toBe(true)
    expect(experiment.pageEvents.map(e => [e.type, e.visibilityState, e.persisted])).toEqual([
      ['visibilitychange', 'hidden', undefined],
      ['pagehide', 'hidden', true],
      ['visibilitychange', 'visible', undefined],
      ['pageshow', 'visible', true],
    ])
  })

  it('trace: records the page events in the original handlers, which still abort', async () => {
    renderPage(readExperimentConfig('?exp=trace'))
    expect(pageListenerTypes()).toEqual(['pagehide', 'pageshow', 'visibilitychange'])
    await startRecording(0)
    act(() => { setVisibility('hidden') })
    expect(recorders.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
    act(() => { setVisibility('visible') })
    act(() => { window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false })) })
    act(() => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })) })
    const json = await copyJson()
    const experiment = json.diagnostics.experiment as unknown as { traceListenerOnly: boolean; pageEvents: { type: string; persisted?: boolean }[] }
    expect(experiment.traceListenerOnly).toBe(false)
    expect(experiment.pageEvents.map(e => [e.type, e.persisted])).toEqual([
      ['visibilitychange', undefined], ['visibilitychange', undefined], ['pagehide', false], ['pageshow', false],
    ])
  })

  it('removes the record-only listeners when the screen goes away', () => {
    const docRemove = vi.spyOn(document, 'removeEventListener')
    const winRemove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderPage(readExperimentConfig('?exp=nolifecycle,trace'))
    unmount()
    const removed = [...docRemove.mock.calls, ...winRemove.mock.calls].map(c => String(c[0])).filter(t => PAGE_EVENTS.includes(t)).sort()
    expect(removed).toEqual(['pagehide', 'pageshow', 'visibilitychange'])
  })
})
