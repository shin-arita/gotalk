import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { readExperimentConfig } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import type { AudioSession } from '../hooks/useAudioSession'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'
import {
  AUDIO_GLOBALS, firePageTransition, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition, setVisibility, ttsContextOf,
} from '../test/audioMocks'
import type { FakeAudioContext } from '../test/audioMocks'

// 録音中の画面（オーバーレイ）、click shield、棒グラフ、読み上げの時間の記録（docs/ui.md、docs/speech-flow.md）。
// 番号は、PR B の設計の 5.7 のテストの番号。
// jsdom は、画面の上の位置から一番上の要素を選ぶこと（hit test）も inert もしないので、tapAt() で、
// 「その位置をタップすると、一番上に重なっている要素（録音中の画面か盾）に click が届く」ことを再現する

// 録音のセッションは本物（マイクを閉じないセッション）を使い、呼び出しを見るために画面で使うものを取っておく
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

const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)
// vi は vitest の vi と同じ名前になるので、ベトナム語は viet にする
const [ja, en, zhCN, zhTW, ko, th, viet] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let audioContexts: FakeAudioContext[]
let fetchMock: ReturnType<typeof vi.spyOn>
let resolvedGum: number
// /api/tts の応答（既定は成功）
let ttsResponse: () => Response

function okJson(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  captured.session = null
  resolvedGum = 0
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  audioContexts = setupAudioContext().instances
  ttsResponse = makeTtsOkResponse
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === '/api/tts') return ttsResponse()
    if (String(url) === '/api/translate') {
      const { text } = JSON.parse(String((options as RequestInit).body)) as { text: string }
      return okJson({ translatedText: `訳:${text}`, backTranslation: '', sourceLanguage: 'ja', targetLanguage: 'en' })
    }
    return okJson({ text: 'こんにちは', translatedText: 'Hello', ttsText: 'Hello', backTranslation: '(こんにちは)', sourceLanguage: 'ja', targetLanguage: 'en' })
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

function renderPage(options: { languages?: Language[]; experiment?: ExperimentConfig; onBack?: () => void } = {}) {
  const onBack = options.onBack ?? vi.fn()
  const result = render(<InterpreterPage selectedLanguages={options.languages ?? [ja, en]} onBack={onBack} experiment={options.experiment} />)
  return { ...result, onBack }
}

const session = () => captured.session!
const overlay = () => document.querySelector<HTMLElement>('.recording-overlay')
const overlayButton = () => document.querySelector<HTMLButtonElement>('.recording-overlay__button')
const overlayText = () => document.querySelector<HTMLElement>('.recording-overlay__text')
const shield = () => document.querySelector<HTMLElement>('.recording-click-shield')
const bars = () => document.querySelector<HTMLElement>('.recording-overlay__bars')
const isFlowing = () => bars()?.classList.contains('recording-overlay__bars--flowing') ?? false
const flagButton = (lang: Language) => screen.getByRole('button', { name: new RegExp(`^${lang.label}(で話す|の録音を停止)$`) })
const isRecording = () => screen.queryByRole('button', { name: 'Japaneseの録音を停止' }) !== null
const isIdle = () => !flagButton(ja).hasAttribute('disabled') && !isRecording()

// 画面のその位置をタップする。録音中の画面か盾が重なっていれば、click はそちらに届く（下の要素には届かない）
function tapAt(el: Element) {
  const top = shield() ?? overlay()
  if (top && !top.contains(el)) {
    // 下の要素は inert の中にある（キーボードやスクリーンリーダーでも操作できない）
    expect(el.closest('[inert]')).not.toBeNull()
    fireEvent.click(top)
  } else {
    fireEvent.click(el)
  }
}

async function tap(el: Element) {
  await act(async () => { tapAt(el) })
}

// 国旗をタップし、まだ終わらせていない getUserMedia があれば終わらせて recording にする
async function startRecording(lang: Language = ja) {
  await tap(flagButton(lang))
  if (gum.calls.length > resolvedGum) {
    const index = resolvedGum
    resolvedGum += 1
    await act(async () => { await gum.calls[index].resolve() })
  }
}

async function finishRecorder(data = AUDIO_DATA) {
  const recorder = recorders.instances.at(-1)!
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob([data]) })
    recorder.onstop?.()
  })
}

async function sendTranscript(transcript: string) {
  await act(async () => { recognitions.instances.at(-1)!.onresult?.({ results: [[{ transcript }]] }) })
}

async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

// 録音して止め、翻訳の結果を出して ready にする（盾の時間も過ぎた後）
async function reachReady() {
  vi.useFakeTimers()
  await startRecording()
  await sendTranscript('こんにちは')
  await tap(overlay()!)
  await finishRecorder()
  await advance(400)
  expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
}

async function copyEventTypes(): Promise<string[]> {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { writes.push(text) }) }, configurable: true })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
  return (JSON.parse(writes.at(-1)!) as { diagnostics: { events: { type: string }[] } }).diagnostics.events.map(e => e.type)
}

describe('InterpreterPage recording overlay: appearance (5.7-1)', () => {
  it.each([
    [[ja, en], 0, '話し終わったら画面をタップしてください', 'キャンセル', '停止'],
    [[ja, en], 1, 'When you finish speaking, tap the screen.', 'Cancel', 'Stop'],
    [[zhCN, ko], 0, '说完后请点击屏幕。', '取消', '停止'],
    [[zhCN, ko], 1, '말씀이 끝나면 화면을 탭해 주세요.', '취소', '정지'],
  ] as [Language[], 0 | 1, string, string, string][])('shows the guide only in the language of the tapped flag (%#)', async (languages, index, guide, cancel, stop) => {
    renderPage({ languages })
    await tap(flagButton(languages[index]))
    // starting の間から出る。下のボタンは ×（キャンセル）
    const dialog = screen.getByRole('dialog', { name: guide })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(document.querySelector('.recording-overlay__guide')?.textContent).toBe(guide)
    // もう1つの言語の案内は出さない
    const otherGuide = { ja: '話し終わったら', en: 'When you finish', 'zh-CN': '说完后', ko: '말씀이 끝나면' }[languages[1 - index].id]!
    expect(dialog.textContent).not.toContain(otherGuide)
    expect(overlayButton()).toHaveAttribute('aria-label', cancel)
    // recording になると ■（停止）
    await act(async () => { await gum.calls[0].resolve() })
    expect(overlayButton()).toHaveAttribute('aria-label', stop)
  })
})

// 7言語の案内、停止、キャンセルの文字（TT3）。製品のコードの表を import せず、設計の表の文字を書く
const RECORDING_TEXTS: [Language, string, string, string][] = [
  [ja, '話し終わったら画面をタップしてください', '停止', 'キャンセル'],
  [en, 'When you finish speaking, tap the screen.', 'Stop', 'Cancel'],
  [zhCN, '说完后请点击屏幕。', '停止', '取消'],
  [zhTW, '說完後請點擊螢幕。', '停止', '取消'],
  [ko, '말씀이 끝나면 화면을 탭해 주세요.', '정지', '취소'],
  [th, 'เมื่อพูดจบแล้ว กรุณาแตะหน้าจอ', 'หยุด', 'ยกเลิก'],
  [viet, 'Khi nói xong, vui lòng chạm vào màn hình.', 'Dừng', 'Hủy'],
]

describe('InterpreterPage recording overlay: texts in all 7 languages (TT3)', () => {
  it.each(RECORDING_TEXTS.map(([lang, guide, stop, cancel]) => [lang.id, lang, guide, stop, cancel] as const))('shows exactly the guide, cancel and stop texts of the tapped flag (%s)', async (_id, lang, guide, stop, cancel) => {
    // もう一方の国旗は、違う文言の言語にする
    const other = lang.id === 'ja' ? en : ja
    const otherGuide = RECORDING_TEXTS.find(([l]) => l.id === other.id)![1]
    renderPage({ languages: [lang, other] })
    await tap(flagButton(lang))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-label', guide)
    expect(document.querySelector('.recording-overlay__guide')?.textContent).toBe(guide)
    expect(dialog.textContent).not.toContain(otherGuide)
    expect(overlayButton()).toHaveAttribute('aria-label', cancel)
    await act(async () => { await gum.calls[0].resolve() })
    expect(overlayButton()).toHaveAttribute('aria-label', stop)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', guide)
  })
})

describe('InterpreterPage recording overlay: stop (5.7-2, 5.7-3)', () => {
  it.each([
    ['the overlay body', () => overlay()!],
    ['the bottom button', () => overlayButton()!],
    ['the guide', () => document.querySelector('.recording-overlay__guide')!],
    ['the text area', () => overlayText()!],
  ])('stops once by tapping %s, goes to stopping, and hides the overlay', async (_name, target) => {
    renderPage()
    await startRecording()
    const stop = vi.spyOn(session(), 'stop')
    await act(async () => { fireEvent.click(target()) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
    expect(captured.session!.getDiagnostics().events.map(e => e.type)).toContain('status:stopping')
  })

  it('stops only once when tapped twice in a row', async () => {
    renderPage()
    await startRecording()
    const stop = vi.spyOn(session(), 'stop')
    const body = overlay()!
    const button = overlayButton()!
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(body)
      fireEvent.click(button)
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops by tapping where the title shows through, without going back', async () => {
    const { onBack } = renderPage()
    await startRecording()
    const stop = vi.spyOn(session(), 'stop')
    await tap(screen.getByRole('button', { name: 'トップ画面へ戻る' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })
})

describe('InterpreterPage recording overlay: starting (5.7-4, 5.7-5)', () => {
  it('does nothing when the overlay body is tapped while starting', async () => {
    renderPage()
    await tap(flagButton(ja))
    const stop = vi.spyOn(session(), 'stop')
    const abort = vi.spyOn(session(), 'abort')
    await act(async () => { fireEvent.click(overlay()!) })
    await act(async () => { fireEvent.click(document.querySelector('.recording-overlay__guide')!) })
    expect(stop).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
    expect(overlay()).not.toBeNull()
  })

  it('cancels with the × button: abort(cancel) once, no session left, idle, no message, and a late start does not record', async () => {
    renderPage()
    await tap(flagButton(ja))
    const abort = vi.spyOn(session(), 'abort')
    await act(async () => { fireEvent.click(overlayButton()!) })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith('cancel')
    expect(session().hasActiveSession()).toBe(false)
    expect(overlay()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // 待っていた getUserMedia が遅れて終わっても、録音にならない（取得した stream は次の録音で使い回す）
    await act(async () => { await gum.calls[0].resolve() })
    expect(isRecording()).toBe(false)
    expect(overlay()).toBeNull()
    expect(recorders.instances).toHaveLength(0)
    expect(session().getDiagnostics().events.map(e => e.type)).toEqual(expect.arrayContaining(['abort:cancel', 'status:idle']))
  })
})

describe('InterpreterPage recording overlay: click shield (5.7-6)', () => {
  it('ignores taps on the flag, the title, edit and speak for 400ms after the overlay hides', async () => {
    const { onBack } = renderPage()
    await reachReady()
    await startRecording()
    await sendTranscript('おはよう')
    await tap(overlay()!)
    expect(overlay()).toBeNull()
    expect(shield()).not.toBeNull()
    await finishRecorder()
    // processing の間は国旗も読み上げも押せないので、ready に戻ってから試す
    expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
    const fetchesBefore = fetchMock.mock.calls.length
    await tap(flagButton(ja))
    await tap(screen.getByRole('button', { name: 'トップ画面へ戻る' }))
    await tap(screen.getByRole('button', { name: '編集' }))
    await tap(screen.getByRole('button', { name: '発声する' }))
    expect(recorders.instances).toHaveLength(2)
    expect(onBack).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '原文を編集' })).toBeNull()
    expect(fetchMock.mock.calls.length).toBe(fetchesBefore)
    await advance(399)
    expect(shield()).not.toBeNull()
    await advance(1)
    expect(shield()).toBeNull()
    expect(document.querySelector('[inert]')).toBeNull()
  })

  it.each([
    ['no transcript and a recording under 1024 bytes', 'tiny'],
    ['no transcript and no data at all', ''],
  ])('does not start a new recording within 400ms when the stop goes straight back to idle (%s)', async (_name, data) => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await tap(overlay()!)
    await finishRecorder(data)
    expect(isIdle()).toBe(true)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(shield()).not.toBeNull()
    await tap(flagButton(ja))
    expect(recorders.instances).toHaveLength(1)
    expect(overlay()).toBeNull()
    // 400ms の後は、通常どおり始められる
    await advance(400)
    expect(shield()).toBeNull()
    await tap(flagButton(ja))
    expect(recorders.instances).toHaveLength(2)
    expect(overlay()).not.toBeNull()
  })

  it('shows the shield after a cancel', async () => {
    vi.useFakeTimers()
    renderPage()
    await tap(flagButton(ja))
    await act(async () => { fireEvent.click(overlayButton()!) })
    expect(shield()).not.toBeNull()
    await tap(flagButton(ja))
    expect(overlay()).toBeNull()
    await advance(400)
    expect(shield()).toBeNull()
  })

  it('shows the shield after an interruption (hidden)', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    expect(overlay()).toBeNull()
    expect(shield()).not.toBeNull()
    await tap(flagButton(ja))
    expect(overlay()).toBeNull()
    expect(recorders.instances).toHaveLength(1)
    await advance(400)
    expect(shield()).toBeNull()
  })

  it('the shield swallows the click and does nothing', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await tap(overlay()!)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    const parentListener = vi.fn()
    document.addEventListener('click', parentListener)
    act(() => { shield()!.dispatchEvent(event) })
    document.removeEventListener('click', parentListener)
    expect(event.defaultPrevented).toBe(true)
    expect(parentListener).not.toHaveBeenCalled()
    expect(recorders.instances).toHaveLength(1)
  })

  it('clears the shield timer when the screen goes away', async () => {
    vi.useFakeTimers()
    const { unmount } = renderPage()
    await startRecording()
    await tap(overlay()!)
    await finishRecorder('')
    // 音量の取得の requestAnimationFrame などが終わるまで進める（盾はまだ出ている）
    await advance(399)
    expect(shield()).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('InterpreterPage recording overlay: text (5.7-7, 5.7-8)', () => {
  it('shows the transcript and the live translation in the overlay, not the old recording UI', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await sendTranscript('こんにちは')
    expect(document.querySelector('.recording-overlay__source')?.textContent).toBe('こんにちは')
    expect(document.querySelector('.recording-overlay__live-translation')).toBeNull()
    await advance(800)
    expect(document.querySelector('.recording-overlay__live-translation')?.textContent).toBe('訳:こんにちは')
    // 今までの録音中の表示は出さない
    expect(document.querySelector('.live-translation-card')).toBeNull()
    expect(document.querySelector('.lang-flags-bar__scroll-text')).toBeNull()
    expect(document.querySelector('.flag-ripple')).toBeNull()
    // 録音中の国旗は赤い縁取りだけで、脈打ちのアニメーションのクラスは付かない
    const flag = flagButton(ja)
    expect(flag).toHaveClass('lang-flags-bar__btn--recording-static')
    expect(flag).not.toHaveClass('lang-flags-bar__btn--recording')
  })

  it('scrolls the text area to the end when the transcript or the live translation changes', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    const el = overlayText()!
    let scrollHeight = 500
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    el.scrollTop = 0
    await sendTranscript('一行目')
    expect(el.scrollTop).toBe(500)
    // 利用者が戻していても、新しい文字が届けば末尾に戻す
    el.scrollTop = 10
    scrollHeight = 900
    await sendTranscript('一行目 二行目')
    expect(el.scrollTop).toBe(900)
    el.scrollTop = 10
    scrollHeight = 1200
    await advance(800)
    expect(document.querySelector('.recording-overlay__live-translation')?.textContent).toBe('訳:一行目 二行目')
    expect(el.scrollTop).toBe(1200)
  })
})

describe('InterpreterPage recording overlay: bars (5.7-9)', () => {
  it('flows while the transcript changes, stops after 800ms, and is not extended by the same text', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    expect(isFlowing()).toBe(false)
    await sendTranscript('あ')
    expect(isFlowing()).toBe(true)
    await advance(500)
    // 同じ文字は延長しない
    await sendTranscript('あ')
    await advance(300)
    expect(isFlowing()).toBe(false)
    await sendTranscript('あい')
    expect(isFlowing()).toBe(true)
    await advance(500)
    // 違う文字なら延長する
    await sendTranscript('あいう')
    await advance(500)
    expect(isFlowing()).toBe(true)
    await advance(300)
    expect(isFlowing()).toBe(false)
  })

  const startFlowing = async () => {
    await sendTranscript(`文字${Math.random()}`)
    expect(isFlowing()).toBe(true)
  }

  it('stops and leaves no timer on stop', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await startFlowing()
    await tap(overlay()!)
    await finishRecorder()
    await advance(400)
    // 棒グラフのタイマーも盾のタイマーも残らない
    expect(vi.getTimerCount()).toBe(0)
    // 次の録音は止まっている状態から始まる
    await startRecording()
    expect(isFlowing()).toBe(false)
  })

  it('does not flow on a late transcript after the stop, but still shows and sends it (TT2)', async () => {
    vi.useFakeTimers()
    renderPage()
    await startRecording()
    await sendTranscript('こんにちは')
    await tap(overlay()!)
    expect(isFlowing()).toBe(false)
    const timersAtStopping = vi.getTimerCount()
    // MediaRecorder の onstop の前（stopping）に、違う文字の最後の onresult が届く
    await sendTranscript('こんにちは、元気ですか')
    expect(isFlowing()).toBe(false)
    expect(vi.getTimerCount()).toBe(timersAtStopping)
    await finishRecorder()
    // その文字は、今までどおり表示と送信に使う
    const interpret = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]) === '/api/interpret')!
    expect(((interpret[1] as RequestInit).body as FormData).get('transcript')).toBe('こんにちは、元気ですか')
    expect(document.querySelector('.source-card__text')?.textContent).toBe('こんにちは、元気ですか')
    expect(isFlowing()).toBe(false)
  })

  it('stops on interruption and recorder error, and starts stopped on a new recording (no timer left)', async () => {
    vi.useFakeTimers()
    renderPage()
    // 中断（hidden）
    await startRecording()
    await startFlowing()
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    await advance(400)
    expect(vi.getTimerCount()).toBe(0)
    // 録音の失敗（onRecorderError）
    await startRecording()
    await startFlowing()
    await act(async () => { recorders.instances.at(-1)!.onerror?.({}) })
    await advance(400)
    expect(vi.getTimerCount()).toBe(0)
    // 新しい録音（前の録音の文字が残っていても、止まっている状態から始まる）
    await startRecording()
    expect(isFlowing()).toBe(false)
    await startFlowing()
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    await advance(400)
    expect(vi.getTimerCount()).toBe(0)
    await startRecording()
    expect(isFlowing()).toBe(false)
  })

  it('stops on cancel (no timer left)', async () => {
    vi.useFakeTimers()
    renderPage()
    await tap(flagButton(ja))
    await act(async () => { fireEvent.click(overlayButton()!) })
    await advance(400)
    expect(vi.getTimerCount()).toBe(0)
    expect(bars()).toBeNull()
  })

  it('stops on onStartFailed (no timer left)', async () => {
    vi.useFakeTimers()
    renderPage()
    await tap(flagButton(ja))
    await act(async () => { await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(overlay()).toBeNull()
    await advance(400)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('InterpreterPage recording overlay: hides on interruption and failure (5.7-10)', () => {
  it.each([
    ['hidden', async () => { await act(async () => { setVisibility('hidden') }); await act(async () => { setVisibility('visible') }) }],
    ['pagehide', async () => { await act(async () => { firePageTransition('pagehide', true) }) }],
    ['onRecorderError', async () => { await act(async () => { recorders.instances.at(-1)!.onerror?.({}) }) }],
  ])('hides the overlay on %s', async (_name, interruptNow) => {
    renderPage()
    await startRecording()
    expect(overlay()).not.toBeNull()
    await interruptNow()
    expect(overlay()).toBeNull()
  })

  it('hides the overlay on back', async () => {
    const { onBack } = renderPage()
    await startRecording()
    // 録音中の画面の下の題名は押せないので、題名の onClick を直接呼ぶ（中断の back の片付けを確かめる）
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' })) })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
  })

  it('hides the overlay on onStartFailed', async () => {
    renderPage()
    await tap(flagButton(ja))
    expect(overlay()).not.toBeNull()
    await act(async () => { await gum.calls[0].reject(new DOMException('denied', 'NotAllowedError')) })
    expect(overlay()).toBeNull()
  })
})

describe('InterpreterPage recording overlay: inert and focus (5.7-11)', () => {
  it('makes the header, the flags, the content and the experiment panel inert while shown and during the shield, and focuses the button', async () => {
    vi.useFakeTimers()
    renderPage({ experiment: readExperimentConfig('?exp=') })
    const underlay = () => [
      document.querySelector('.interpreter-header')!,
      document.querySelector('.lang-flags-bar')!,
      document.querySelector('.page-content')!,
      screen.getByRole('region', { name: '実験の診断' }).parentElement!,
    ]
    for (const el of underlay()) expect(el).not.toHaveAttribute('inert')
    await tap(flagButton(ja))
    for (const el of underlay()) expect(el).toHaveAttribute('inert')
    expect(document.activeElement).toBe(overlayButton())
    await act(async () => { await gum.calls[0].resolve() })
    await tap(overlay()!)
    expect(overlay()).toBeNull()
    for (const el of underlay()) expect(el).toHaveAttribute('inert')
    await advance(400)
    for (const el of underlay()) expect(el).not.toHaveAttribute('inert')
  })

  it('marks the text area as a polite live region', async () => {
    renderPage()
    await tap(flagButton(ja))
    expect(overlayText()).toHaveAttribute('aria-live', 'polite')
  })
})

describe('InterpreterPage TTS timing records (5.7-12)', () => {
  it('records tts_tap, tts_response, tts_downloaded, tts_decoded and tts_started in this order', async () => {
    renderPage({ experiment: readExperimentConfig('?exp=') })
    await reachReady()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    await act(async () => { await Promise.resolve() })
    expect(ttsContextOf(audioContexts)!.bufferSources.at(-1)!.start).toHaveBeenCalledTimes(1)
    const tts = (await copyEventTypes()).filter(t => t.startsWith('tts_'))
    expect(tts).toEqual(['tts_tap', 'tts_response:status=200', 'tts_downloaded:bytes=3', 'tts_decoded:ms=1000', 'tts_started'])
  })

  it('records only tts_tap and tts_response when /api/tts fails', async () => {
    ttsResponse = () => ({ ok: false, status: 503, json: () => Promise.resolve({ error: 'service_busy' }) } as unknown as Response)
    renderPage({ experiment: readExperimentConfig('?exp=') })
    await reachReady()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    await act(async () => { await Promise.resolve() })
    const tts = (await copyEventTypes()).filter(t => t.startsWith('tts_'))
    expect(tts).toEqual(['tts_tap', 'tts_response:status=503'])
  })
})
