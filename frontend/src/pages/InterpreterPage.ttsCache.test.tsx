import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import InterpreterPage from './InterpreterPage'
import { API_TIMEOUT_MS, MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { LANGUAGES } from '../languages'
import {
  AUDIO_GLOBALS, firePageTransition, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition, setVisibility, ttsContextOf,
} from '../test/audioMocks'
import type { FakeAudioContext, FakeBufferSource } from '../test/audioMocks'
import type { AudioSession } from '../hooks/useAudioSession'

// 読み上げの音声を取っておく（GOTALK-2、docs/speech-flow.md の「読み上げ」）。デコード済みの AudioBuffer と、その元の文字の組を
// 1つだけ持ち、同じ文字の2回目からは /api/tts と decodeAudioData() を呼ばずに鳴らす。
// 読み上げの時間の記録（tts_response、tts_cache_hit など）と画面の状態（status:…）は、録音のセッションの診断の出来事で確かめる。
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

const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)
const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let audioContexts: FakeAudioContext[]
let fetchMock: ReturnType<typeof vi.spyOn>
let resolvedGum: number
// /api/interpret の翻訳（ttsText も同じ文字にする）
let interpretTranslation: string
// /api/translate の応答の ttsText（既定は「訳:」を付けた文字）
let translateTts: (text: string) => string
// /api/tts の応答（既定は成功）
let ttsResponse: (options: RequestInit) => Response | Promise<Response>

function okJson(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

// abort されるまで終わらない fetch（abort されると AbortError で拒否する）
function pendingUntilAborted(options: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
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
  interpretTranslation = 'Hello'
  translateTts = text => `訳:${text}`
  ttsResponse = makeTtsOkResponse
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === '/api/tts') return ttsResponse(options ?? {})
    if (String(url) === '/api/translate') {
      const { text } = JSON.parse(String((options as RequestInit).body)) as { text: string }
      const tts = translateTts(text)
      return okJson({ translatedText: tts, ttsText: tts, backTranslation: `逆:${text}`, sourceLanguage: 'ja', targetLanguage: 'en' })
    }
    return okJson({ text: 'こんにちは', translatedText: interpretTranslation, ttsText: interpretTranslation, backTranslation: '(こんにちは)', sourceLanguage: 'ja', targetLanguage: 'en' })
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  restoreGlobals()
})

function renderPage() {
  return render(<InterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} />)
}

const speakButton = () => screen.queryByRole('button', { name: '発声する' })
const ttsCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/tts')
const ttsTexts = () => ttsCalls().map((call: unknown[]) => (JSON.parse(String((call[1] as RequestInit).body)) as { text: string }).text)
const translateCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/translate')
const ttsContext = () => ttsContextOf(audioContexts)!
const lastSource = () => ttsContext().bufferSources.at(-1)!
const eventTypes = () => captured.session!.getDiagnostics().events.map(e => e.type)
const countEvents = (prefix: string) => eventTypes().filter(t => t.startsWith(prefix)).length
// 最後に記録された画面の状態
const lastStatus = () => eventTypes().filter(t => t.startsWith('status:')).at(-1)

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

// 録音して止め、/api/interpret の翻訳（interpretTranslation）を出して ready にする
async function recordAndTranslate() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
  if (gum.calls.length > resolvedGum) {
    const index = resolvedGum
    resolvedGum += 1
    await act(async () => { await gum.calls[index].resolve() })
  }
  await act(async () => { recognitions.instances.at(-1)!.onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
  await act(async () => { fireEvent.click(document.querySelector('.recording-overlay')!) })
  const recorder = recorders.instances.at(-1)!
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob([AUDIO_DATA]) })
    recorder.onstop?.()
  })
  await flush()
  expect(speakButton()).not.toBeDisabled()
}

// 原文の入力（原文が空のとき）か編集をして、Enter で確定し、/api/translate の翻訳を出す
async function typeAndTranslate(text: string) {
  await act(async () => { fireEvent.click(document.querySelector('.source-card__edit')!) })
  const textarea = screen.getByRole('textbox', { name: '原文を編集' })
  fireEvent.change(textarea, { target: { value: text } })
  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }) })
  await flush()
  expect(speakButton()).not.toBeDisabled()
}

// 読み上げのボタンを押し、鳴らすところ（AudioBufferSourceNode の start()）まで進める
async function tapSpeak() {
  await act(async () => { fireEvent.click(speakButton()!) })
  await flush()
}

// 今鳴らしている音を最後まで鳴らし、ready に戻す
function endPlayback() {
  act(() => { lastSource().onended?.() })
  expect(lastStatus()).toBe('status:ready')
}

describe('InterpreterPage tts cache: the same text (GOTALK-2)', () => {
  it('calls /api/tts and decodeAudioData once and plays twice when the same translation is read twice', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    expect(lastStatus()).toBe('status:speaking')
    endPlayback()
    await tapSpeak()
    expect(lastStatus()).toBe('status:speaking')
    endPlayback()

    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(ttsContext().createBufferSource).toHaveBeenCalledTimes(2)
    // 鳴らすたびに新しい AudioBufferSourceNode を作り、同じ AudioBuffer を入れる
    const [first, second] = ttsContext().bufferSources
    expect(first).not.toBe(second)
    expect(first.start).toHaveBeenCalledTimes(1)
    expect(second.start).toHaveBeenCalledTimes(1)
    expect(second.buffer).toBe(first.buffer)
    expect(speakButton()).not.toBeDisabled()

    // 2回目は tts_cache_hit を残し、tts_response、tts_downloaded、tts_decoded は残らない
    expect(countEvents('tts_response')).toBe(1)
    expect(countEvents('tts_downloaded')).toBe(1)
    expect(countEvents('tts_decoded')).toBe(1)
    const events = eventTypes()
    const secondTap = events.lastIndexOf('tts_tap')
    expect(events.slice(secondTap).filter(t => t.startsWith('tts_'))).toEqual(['tts_tap', 'tts_cache_hit:ms=1000', 'tts_started'])
  })

  it('does not call /api/tts when the retranslation returns the same ttsText', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    // 原文を変えて訳し直したが、読み上げる文字は同じ
    translateTts = () => 'Hello'
    await typeAndTranslate('こんにちは！')
    expect(translateCalls()).toHaveLength(1)
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(countEvents('tts_cache_hit')).toBe(1)
  })
})

describe('InterpreterPage tts cache: a new text (GOTALK-2)', () => {
  it('calls /api/tts with the new text after recording again', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    interpretTranslation = 'Good evening'
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    expect(ttsTexts()).toEqual(['Hello', 'Good evening'])
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(2)
    expect(countEvents('tts_cache_hit')).toBe(0)
    // 新しい翻訳の読み上げで上書きしたので、もう一度読むと新しい翻訳の音声を使う
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(lastSource().buffer).toBe(ttsContext().bufferSources[1].buffer)
    expect(countEvents('tts_cache_hit')).toBe(1)
  })

  it('calls /api/tts with the new text after the source is edited and retranslated', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    await typeAndTranslate('こんばんは')
    await tapSpeak()
    expect(ttsTexts()).toEqual(['Hello', '訳:こんばんは'])
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(2)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })

  it('calls /api/tts with the new text after a text is typed into the empty source', async () => {
    renderPage()
    await typeAndTranslate('駅はどこですか')
    await tapSpeak()
    endPlayback()
    await typeAndTranslate('ありがとう')
    await tapSpeak()
    expect(ttsTexts()).toEqual(['訳:駅はどこですか', '訳:ありがとう'])
    expect(countEvents('tts_cache_hit')).toBe(0)
  })
})

describe('InterpreterPage tts cache: not kept after a failure (GOTALK-2)', () => {
  it.each([
    ['500', () => ({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response)],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('calls /api/tts again on the next tap after /api/tts fails with %s', async (_, fail) => {
    ttsResponse = fail
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    expect(lastStatus()).toBe('status:ready')
    expect(ttsContext().bufferSources).toHaveLength(0)
    ttsResponse = makeTtsOkResponse
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })

  it('calls /api/tts again on the next tap after /api/tts times out', async () => {
    vi.useFakeTimers()
    ttsResponse = pendingUntilAborted
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    expect(lastStatus()).toBe('status:speaking')
    await act(async () => { vi.advanceTimersByTime(API_TIMEOUT_MS.tts) })
    await flush()
    expect(lastStatus()).toBe('status:ready')
    ttsResponse = makeTtsOkResponse
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })

  it('calls /api/tts and decodeAudioData again on the next tap after decodeAudioData fails', async () => {
    audioContexts = setupAudioContext({ decodeRejects: true }).instances
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    expect(lastStatus()).toBe('status:ready')
    expect(ttsContext().bufferSources).toHaveLength(0)
    ttsContext().decodeAudioData.mockImplementation(() => Promise.resolve({ duration: 1 }))
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })

  it('does not keep the audio when hidden while /api/tts is in flight, and calls /api/tts on the next tap', async () => {
    let respond: (res: Response) => void = () => {}
    ttsResponse = () => new Promise<Response>(resolve => { respond = resolve })
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    expect(lastStatus()).toBe('status:ready')
    // 止めた後に遅れて届いた音声は、鳴らさず、取っておかない
    await act(async () => { respond(makeTtsOkResponse()) })
    await flush()
    expect(ttsContext().bufferSources).toHaveLength(0)
    ttsResponse = makeTtsOkResponse
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })

  it('does not keep the audio when hidden while decodeAudioData is in flight, and calls /api/tts on the next tap', async () => {
    let respond: (res: Response) => void = () => {}
    ttsResponse = () => new Promise<Response>(resolve => { respond = resolve })
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    // 読み上げの AudioContext ができた後に、decodeAudioData をテストが終わらせるまで待たせる
    let decoded: (buffer: { duration: number }) => void = () => {}
    ttsContext().decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { decoded = resolve }))
    await act(async () => { respond(makeTtsOkResponse()) })
    await flush()
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    expect(lastStatus()).toBe('status:ready')
    await act(async () => { decoded({ duration: 1 }) })
    await flush()
    expect(ttsContext().bufferSources).toHaveLength(0)
    expect(countEvents('tts_decoded')).toBe(1)
    ttsResponse = makeTtsOkResponse
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(2)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })
})

describe('InterpreterPage tts cache: kept after the audio is decoded (GOTALK-2)', () => {
  it('uses the kept audio on the next tap when resume() was rejected the first time', async () => {
    let resumeCount = 0
    audioContexts = setupAudioContext({
      resumeImpl: ctx => {
        resumeCount += 1
        if (resumeCount === 1) return Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
        ctx.state = 'running'
        return Promise.resolve()
      },
    }).instances
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    // 1回目は /api/tts と変換が成功したが、resume() が拒否されて鳴らない
    expect(lastStatus()).toBe('status:ready')
    expect(countEvents('tts_resume_rejected')).toBe(1)
    expect(ttsContext().bufferSources).toHaveLength(0)
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:speaking')
    expect(countEvents('tts_cache_hit')).toBe(1)
    endPlayback()
  })

  it.each([
    ['rejected', (ctx: FakeAudioContext) => { void ctx; return Promise.reject(new DOMException('not allowed', 'NotAllowedError')) }, 'tts_resume_rejected:NotAllowedError'],
    ['not running', (ctx: FakeAudioContext) => { ctx.state = 'suspended'; return Promise.resolve() }, 'tts_resume_not_running:suspended'],
  ])('does not play the kept audio and returns to ready when resume() is %s', async (_, secondResume, event) => {
    let resumeCount = 0
    audioContexts = setupAudioContext({
      resumeImpl: ctx => {
        resumeCount += 1
        if (resumeCount === 2) return secondResume(ctx)
        ctx.state = 'running'
        return Promise.resolve()
      },
    }).instances
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    await tapSpeak()
    expect(countEvents('tts_cache_hit')).toBe(1)
    expect(eventTypes()).toContain(event)
    expect(ttsContext().bufferSources).toHaveLength(1)
    expect(lastStatus()).toBe('status:ready')
    expect(speakButton()).not.toBeDisabled()
    // 鳴らせなくても捨てず、次のタップで使う
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
  })

  it('returns to ready by the watchdog when onended does not come for the kept audio', async () => {
    vi.useFakeTimers()
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    await tapSpeak()
    expect(countEvents('tts_cache_hit')).toBe(1)
    expect(lastStatus()).toBe('status:speaking')
    // 音声の長さ（1秒）＋ 3秒
    await act(async () => { vi.advanceTimersByTime(3999) })
    expect(lastStatus()).toBe('status:speaking')
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(lastStatus()).toBe('status:ready')
    expect(eventTypes()).toContain('tts_ended_timeout')
    expect(lastSource().stop).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['hidden', () => setVisibility('hidden')],
    ['pagehide', () => firePageTransition('pagehide', false)],
  ])('stops the kept audio and returns to ready on %s, and keeps it for the next tap', async (_, interrupt) => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    await tapSpeak()
    const source = lastSource()
    expect(lastStatus()).toBe('status:speaking')
    await act(async () => { interrupt() })
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:ready')
    // 止めた後に遅れて来た onended は、画面を変えない
    act(() => { source.onended?.() })
    expect(lastStatus()).toBe('status:ready')
    await act(async () => {
      setVisibility('visible')
      firePageTransition('pageshow', false)
    })
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(2)
  })
})

describe('InterpreterPage tts cache: kept after start() fails, an edit or bfcache (GOTALK-2 VV2)', () => {
  it('uses the kept audio on the next tap when start() threw the first time', async () => {
    let respond: (res: Response) => void = () => {}
    ttsResponse = () => new Promise<Response>(resolve => { respond = resolve })
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    // 読み上げの AudioContext ができた後に、1回目に作る AudioBufferSourceNode の start() だけを失敗させる
    const createSource = ttsContext().createBufferSource.getMockImplementation() as () => FakeBufferSource
    ttsContext().createBufferSource.mockImplementationOnce(() => {
      const node = createSource()
      node.start.mockImplementation(() => { throw new DOMException('cannot start', 'InvalidStateError') })
      return node
    })
    await act(async () => { respond(makeTtsOkResponse()) })
    await flush()
    // 1回目は /api/tts と変換が成功したが、start() が例外を出して鳴らずに ready に戻る
    expect(ttsContext().bufferSources).toHaveLength(1)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(eventTypes()).not.toContain('tts_started')
    expect(lastStatus()).toBe('status:ready')
    ttsResponse = makeTtsOkResponse
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:speaking')
    endPlayback()
  })

  it('uses the kept audio after the source is edited while speaking and the retranslation returns the same ttsText', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    const source = lastSource()
    expect(lastStatus()).toBe('status:speaking')
    // 読み上げの途中に原文の編集を確定すると、読み上げを止める。訳し直しの読み上げる文字は同じ
    translateTts = () => 'Hello'
    await typeAndTranslate('こんにちは！')
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(translateCalls()).toHaveLength(1)
    expect(lastStatus()).toBe('status:ready')
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:speaking')
    endPlayback()
  })

  it('uses the kept audio after pagehide and pageshow (persisted) while speaking', async () => {
    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    const source = lastSource()
    expect(lastStatus()).toBe('status:speaking')
    // 読み上げの途中に bfcache に入り、戻る
    await act(async () => { firePageTransition('pagehide', true) })
    expect(source.stop).toHaveBeenCalledTimes(1)
    await act(async () => { firePageTransition('pageshow', true) })
    expect(lastStatus()).toBe('status:ready')
    expect(speakButton()).not.toBeDisabled()
    await tapSpeak()
    expect(ttsCalls()).toHaveLength(1)
    expect(ttsContext().decodeAudioData).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(1)
    expect(ttsContext().bufferSources).toHaveLength(2)
    expect(lastSource().start).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:speaking')
    endPlayback()
  })
})

describe('InterpreterPage tts cache: a new screen (GOTALK-2)', () => {
  it('does not use the kept audio after the screen is unmounted and mounted again', async () => {
    const { unmount } = renderPage()
    await recordAndTranslate()
    await tapSpeak()
    endPlayback()
    const firstContext = ttsContext()
    unmount()
    expect(firstContext.close).toHaveBeenCalledTimes(1)

    renderPage()
    await recordAndTranslate()
    await tapSpeak()
    expect(ttsTexts()).toEqual(['Hello', 'Hello'])
    const secondContext = audioContexts.filter(c => c.resume.mock.calls.length > 0).at(-1)!
    expect(secondContext).not.toBe(firstContext)
    expect(secondContext.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(secondContext.bufferSources.at(-1)!.start).toHaveBeenCalledTimes(1)
    expect(countEvents('tts_cache_hit')).toBe(0)
  })
})
