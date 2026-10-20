import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { ComponentProps } from 'react'
import LegacyInterpreterPage from './LegacyInterpreterPage'
import type { ExperimentSnapshot, RecogOnlyDiagnostics, RecogOnlyRecording } from './ExperimentPanel'
import { readExperimentConfig } from '../experiments'
import { LANGUAGES } from '../languages'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import {
  AUDIO_GLOBALS, saveGlobals, setupAnimationFrame, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder, setupSpeechRecognition,
} from '../test/audioMocks'
import type { FakeRecognition } from '../test/audioMocks'

// 5回目の実験の recogonly（getUserMedia も録音もせず、音声認識だけで録音の開始と終了を行う。
// docs/testing.md の「実験のスイッチ」）

// 診断の表示の部品はそのまま使い、read を受け取って、画面が外れた後も記録を読めるようにする
const panel = vi.hoisted(() => ({ read: null as null | (() => unknown) }))
vi.mock('./ExperimentPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ExperimentPanel')>()
  const Panel = actual.default
  return {
    ...actual,
    default: (props: ComponentProps<typeof Panel>) => {
      panel.read = props.read
      return <Panel {...props} />
    },
  }
})

const [ja, en] = LANGUAGES
const TEXT = 'わたしのなまえはありたしんです'

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let contexts: ReturnType<typeof setupAudioContext>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let interpretResponse: () => Promise<Response>

interface FakeAudio {
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  onerror: (() => void) | null
}
let audios: FakeAudio[]

function setupAudio() {
  audios = []
  Object.defineProperty(globalThis, 'Audio', {
    value: vi.fn(function () {
      const audio: FakeAudio = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), onended: null, onerror: null }
      audios.push(audio)
      return audio
    }),
    writable: true,
    configurable: true,
  })
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:fake')
  globalThis.URL.revokeObjectURL = vi.fn()
}

const okResponse = () => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ text: TEXT, translatedText: 'My name is Arita Shin.', ttsText: 'My name is Arita Shin.', backTranslation: '私の名前はありたしんです。', sourceLanguage: 'ja', targetLanguage: 'en' }),
} as unknown as Response)

beforeEach(() => {
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  contexts = setupAudioContext()
  recognitions = setupSpeechRecognition()
  setupAnimationFrame()
  setupAudio()
  panel.read = null
  interpretResponse = okResponse
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (input === '/api/tts') return { ok: true, status: 200, blob: () => Promise.resolve(new Blob(['mp3'])) } as unknown as Response
    if (input === '/api/interpret') return interpretResponse()
    // ライブ翻訳（/api/translate）
    return { ok: true, status: 200, json: () => Promise.resolve({ translatedText: 'live', sourceLanguage: 'ja' }) } as unknown as Response
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  restoreGlobals()
})

function renderRecogOnly() {
  return render(<LegacyInterpreterPage selectedLanguages={[ja, en]} onBack={vi.fn()} experiment={readExperimentConfig('?exp=recogonly')} />)
}

const flag = (label = 'Japanese') => screen.getByRole('button', { name: `${label}で話す` })
const stopFlag = (label = 'Japanese') => screen.getByRole('button', { name: `${label}の録音を停止` })
const diagnostics = () => (panel.read!() as Extract<ExperimentSnapshot, { kind: 'recogonly' }>).diagnostics
const lastRecord = (): RecogOnlyRecording => diagnostics().recordings[diagnostics().recordings.length - 1]
const interpretCalls = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, { body: FormData }][] } }).mock.calls.filter(c => c[0] === '/api/interpret')
const lastForm = () => { const calls = interpretCalls(); return calls[calls.length - 1][1].body }
const recognition = (i = recognitions.instances.length - 1): FakeRecognition => recognitions.instances[i]
const shownText = () => document.querySelector('.source-card__text')?.textContent ?? ''
const message = (key: MessageKey) => getLocalizedMessage(key, ja.id, en.id)
const eventTypes = (r: RecogOnlyRecording) => r.events.map(e => e.type)
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

async function tap(label = 'Japanese') { await act(async () => { fireEvent.click(flag(label)) }) }
async function tapStop(label = 'Japanese') { await act(async () => { fireEvent.click(stopFlag(label)) }) }
// 今回の認識の event.results を渡す（確定と途中の区別は持たない）
async function result(r: FakeRecognition, ...segments: string[]) {
  await act(async () => { r.onresult?.({ results: segments.map(t => [{ transcript: t }]) }) })
}
async function end(r: FakeRecognition) { await act(async () => { r.onend?.() }) }
async function error(r: FakeRecognition, code: string) { await act(async () => { r.onerror?.({ error: code }) }) }

// 1回の発話（開始、文字、利用者の終了、最後の onend）
async function utterance(text = TEXT, label = 'Japanese') {
  await tap(label)
  const r = recognition()
  if (text) await result(r, text)
  await tapStop(label)
  await end(r)
  await flush()
  return r
}

describe('LegacyInterpreterPage with exp=recogonly: start', () => {
  it('starts the recognition synchronously inside the tap without getUserMedia, MediaRecorder or AudioContext', () => {
    renderRecogOnly()
    // act の中で Promise を進める前に start() が呼ばれている
    act(() => { fireEvent.click(flag()) })
    expect(recognitions.instances).toHaveLength(1)
    const r = recognition()
    expect(r.start).toHaveBeenCalledTimes(1)
    expect(r.lang).toBe('ja-JP')
    expect(r.continuous).toBe(true)
    expect(r.interimResults).toBe(true)
    expect(gum.getUserMedia).not.toHaveBeenCalled()
    expect(recorders.Ctor).not.toHaveBeenCalled()
    expect(contexts.Ctor).not.toHaveBeenCalled()
    expect(stopFlag()).toBeInTheDocument()
  })

  it('sets recordingFlagIndex to the tapped flag (0 and 1)', async () => {
    renderRecogOnly()
    await tap('Japanese')
    expect(stopFlag('Japanese')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Englishの録音を停止' })).toBeNull()
    await tapStop('Japanese')
    await end(recognition())
    await flush()
    await tap('English')
    expect(stopFlag('English')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
    expect(recognition().lang).toBe('en-US')
  })

  it('creates the record with the initial values of the list', async () => {
    renderRecogOnly()
    await tap()
    const r = lastRecord()
    expect(r).toEqual({
      recordingNo: 1, lang: 'ja', recognitionCtorMissing: false, utteranceStartedAt: expect.any(Number), startCalledAt: expect.any(Number),
      stopCalledAt: null, finishedAt: null, startError: null, stopError: null,
      events: [{ type: 'start', at: expect.any(Number), by: 'gesture' }], eventsDropped: 0,
      autoRestarts: 0, restartErrors: [], restartLimitReached: false, silenceBeforeAutoEndMs: [], stopToEndMs: null, endTimeoutFired: false,
      finishReason: null, finalTextLength: null, segments: 0, transcriptSent: false, interpretResult: null,
    })
    expect(diagnostics().recognitionStarts).toEqual({ gesture: 1, restart: 0 })
  })

  it('records ctor-missing without a recognition and goes back to idle with recording_start_failed', async () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    renderRecogOnly()
    await tap()
    const r = lastRecord()
    expect(diagnostics().recordings).toHaveLength(1)
    expect(r.recognitionCtorMissing).toBe(true)
    expect(r.finishReason).toBe('ctor-missing')
    expect(r.finishedAt).not.toBeNull()
    expect(r.startCalledAt).toBeNull()
    expect(r.events).toEqual([])
    expect(diagnostics().recognitionStarts.gesture).toBe(0)
    expect(interpretCalls()).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe(message('recording_start_failed'))
    // idle に戻り、recordingFlagIndex も null
    expect(flag()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
  })

  it('records start-error when the first start() throws', async () => {
    recognitions = setupSpeechRecognition({ throwOnStart: { from: 1, only: true } })
    renderRecogOnly()
    await tap()
    const r = lastRecord()
    expect(r.startCalledAt).not.toBeNull()
    expect(diagnostics().recognitionStarts.gesture).toBe(1)
    expect(r.startError).toBe('InvalidStateError')
    expect(r.finishReason).toBe('start-error')
    expect(r.finalTextLength).toBeNull()
    expect(interpretCalls()).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe(message('recording_start_failed'))
    expect(flag()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
    expect(recognition().abort).not.toHaveBeenCalled()
  })
})

describe('LegacyInterpreterPage with exp=recogonly: one utterance', () => {
  it('runs the second language through once (speaker en, English to Japanese)', async () => {
    interpretResponse = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ text: 'My name is Shin', translatedText: '私の名前はシンです', ttsText: '私の名前はシンです', backTranslation: 'My name is Shin', sourceLanguage: 'en', targetLanguage: 'ja' }),
    } as unknown as Response)
    renderRecogOnly()
    await tap('English')
    const r = recognition()
    await result(r, 'My name is Shin')
    await tapStop('English')
    expect(r.stop).toHaveBeenCalledTimes(1)
    await end(r)
    await flush()
    expect(interpretCalls()).toHaveLength(1)
    const form = lastForm()
    expect(form.get('speaker')).toBe('en')
    expect(JSON.parse(form.get('myLanguage') as string).id).toBe('en')
    expect(JSON.parse(form.get('theirLanguage') as string).id).toBe('ja')
    expect(form.get('transcript')).toBe('My name is Shin')
    expect(document.querySelector('.translation-card__text')).toHaveTextContent('私の名前はシンです')
    expect(flag('English')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Englishの録音を停止' })).toBeNull()
  })

  it('sends a 0-byte audio, the transcript and the speaker', async () => {
    renderRecogOnly()
    await utterance()
    const form = lastForm()
    const audio = form.get('audio') as File
    expect(audio.size).toBe(0)
    expect(audio.type).toBe('audio/webm')
    expect(audio.name).toBe('recording.webm')
    expect(form.get('transcript')).toBe(TEXT)
    expect(form.get('speaker')).toBe('ja')
    const r = lastRecord()
    expect(r.transcriptSent).toBe(true)
    expect(r.interpretResult).toBe('ok')
    expect(r.finishReason).toBe('user-stop')
    expect(r.finalTextLength).toBe(15)
    expect(shownText()).toBe(TEXT)
  })

  it('moves to processing right after the second tap and ignores a second stop', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    await tapStop()
    // processing：国旗は押せず、録音中の表示でもない
    expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
    expect(flag()).toBeDisabled()
    expect(flag('English')).toBeDisabled()
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled()
    await act(async () => { fireEvent.click(flag()) })
    expect(r.stop).toHaveBeenCalledTimes(1)
    expect(interpretCalls()).toHaveLength(0)
    await end(r)
    await flush()
    expect(interpretCalls()).toHaveLength(1)
    const rec = lastRecord()
    expect(rec.stopCalledAt).not.toBeNull()
    expect(rec.stopToEndMs).not.toBeNull()
    expect(rec.endTimeoutFired).toBe(false)
    expect(eventTypes(rec)).toEqual(['start', 'result', 'stop', 'end'])
    expect(rec.events[3].phase).toBe('stopping')
    expect(r.abort).not.toHaveBeenCalled()
  })

  it('counts only one segment for many results in one recognition', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, 'わたし')
    await result(r, 'わたしの')
    await result(r, 'わたしのなまえは')
    await tapStop()
    await end(r)
    await flush()
    expect(lastRecord().segments).toBe(1)
  })

  it('counts the code points of the trimmed text', async () => {
    renderRecogOnly()
    await utterance(`  ${TEXT} `)
    expect(lastRecord().finalTextLength).toBe(15)
    expect(lastForm().get('transcript')).toBe(TEXT)
  })

  it('does not send an empty text and shows recording_failed', async () => {
    renderRecogOnly()
    await utterance('')
    const r = lastRecord()
    expect(interpretCalls()).toHaveLength(0)
    expect(r.transcriptSent).toBe(false)
    expect(r.interpretResult).toBe('empty')
    expect(r.finalTextLength).toBe(0)
    expect(screen.getByRole('alert').textContent).toBe(message('recording_failed'))
    expect(flag()).toBeEnabled()
  })

  it('records the stop() exception in stopError and still waits for onend', async () => {
    recognitions = setupSpeechRecognition({ throwOnStop: true })
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    await tapStop()
    expect(lastRecord().stopError).toBe('Error')
    expect(lastRecord().finishReason).toBeNull()
    await end(r)
    await flush()
    expect(lastRecord().finishReason).toBe('user-stop')
    expect(interpretCalls()).toHaveLength(1)
  })
})

describe('LegacyInterpreterPage with exp=recogonly: automatic end and restart', () => {
  it('commits the interim text on the automatic onend and restarts the same recognition', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, 'わたしのなまえは')
    await end(r)
    expect(recognitions.instances).toHaveLength(1)
    expect(r.start).toHaveBeenCalledTimes(2)
    // 始め直した後の認識の結果は、前の文字の後につながる
    await result(r, 'ありたしんです')
    expect(shownText()).toBe(TEXT)
    await tapStop()
    await end(r)
    await flush()
    expect(lastForm().get('transcript')).toBe(TEXT)
    const rec = lastRecord()
    expect(rec.autoRestarts).toBe(1)
    expect(rec.segments).toBe(2)
    expect(rec.silenceBeforeAutoEndMs).toHaveLength(1)
    expect(rec.silenceBeforeAutoEndMs[0]).toEqual(expect.any(Number))
    expect(diagnostics().recognitionStarts).toEqual({ gesture: 1, restart: 1 })
    expect(rec.events.filter(e => e.type === 'start').map(e => e.by)).toEqual(['gesture', 'restart'])
    expect(rec.events.find(e => e.type === 'end')?.phase).toBe('listening')
  })

  it('records null silence and no segment for a restarted recognition without results', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, 'わたしのなまえは')
    await end(r)
    await end(r)
    const rec = lastRecord()
    expect(rec.silenceBeforeAutoEndMs).toHaveLength(2)
    expect(rec.silenceBeforeAutoEndMs[0]).toEqual(expect.any(Number))
    expect(rec.silenceBeforeAutoEndMs[1]).toBeNull()
    expect(rec.segments).toBe(1)
  })

  it('finishes with restart-limit on the 21st automatic end and sends the text so far', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    for (let i = 0; i < 20; i++) await end(r)
    expect(r.start).toHaveBeenCalledTimes(21)
    expect(lastRecord().restartLimitReached).toBe(false)
    await end(r)
    await flush()
    expect(r.start).toHaveBeenCalledTimes(21)
    const rec = lastRecord()
    expect(rec.restartLimitReached).toBe(true)
    expect(rec.autoRestarts).toBe(20)
    expect(rec.finishReason).toBe('restart-limit')
    expect(diagnostics().recognitionStarts.restart).toBe(20)
    expect(interpretCalls()).toHaveLength(1)
    expect(lastForm().get('transcript')).toBe(TEXT)
    expect(flag()).toBeEnabled()
  })

  it('finishes with restart-start-error when the restart start() throws', async () => {
    recognitions = setupSpeechRecognition({ throwOnStart: { from: 2 } })
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    await end(r)
    await flush()
    const rec = lastRecord()
    expect(rec.autoRestarts).toBe(1)
    expect(rec.restartErrors).toEqual(['InvalidStateError'])
    expect(rec.finishReason).toBe('restart-start-error')
    expect(interpretCalls()).toHaveLength(1)
  })

  it('only records no-speech and restarts on the following onend', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await error(r, 'no-speech')
    expect(lastRecord().finishReason).toBeNull()
    await end(r)
    expect(r.start).toHaveBeenCalledTimes(2)
    expect(lastRecord().events.find(e => e.type === 'error')).toEqual({ type: 'error', at: expect.any(Number), error: 'no-speech' })
  })
})

describe('LegacyInterpreterPage with exp=recogonly: end timeout', () => {
  it('sends once after 2000ms, then aborts, and ignores the late onend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    await tapStop()
    await act(async () => { vi.advanceTimersByTime(1999) })
    expect(interpretCalls()).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect(interpretCalls()).toHaveLength(1)
    expect(r.abort).toHaveBeenCalledTimes(1)
    // 翻訳を始めた後に abort() を呼ぶ
    const fetchOrder = (globalThis.fetch as unknown as { mock: { calls: [unknown][]; invocationCallOrder: number[] } }).mock
    const interpretOrder = fetchOrder.invocationCallOrder[fetchOrder.calls.findIndex(c => c[0] === '/api/interpret')]
    expect(interpretOrder).toBeLessThan(r.abort.mock.invocationCallOrder[0])
    let rec = lastRecord()
    expect(rec.endTimeoutFired).toBe(true)
    expect(rec.stopToEndMs).toBeNull()
    expect(rec.finishReason).toBe('end-timeout')
    await end(r)
    await flush()
    expect(interpretCalls()).toHaveLength(1)
    expect(r.start).toHaveBeenCalledTimes(1)
    expect(r.abort).toHaveBeenCalledTimes(1)
    rec = lastRecord()
    expect(eventTypes(rec)).toEqual(['start', 'result', 'stop', 'abort', 'end'])
    expect(rec.events[4].phase).toBe('finished')
    expect(rec.events.filter(e => e.type === 'abort')).toHaveLength(1)
  })

  it('clears the timer when onend comes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderRecogOnly()
    await utterance()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(recognition().abort).not.toHaveBeenCalled()
    expect(lastRecord().endTimeoutFired).toBe(false)
  })
})

describe('LegacyInterpreterPage with exp=recogonly: discard', () => {
  for (const code of ['not-allowed', 'service-not-allowed'] as const) {
    it(`discards on ${code}: aborts once, shows microphone_denied and ignores the following onend`, async () => {
      renderRecogOnly()
      await tap()
      const r = recognition()
      await result(r, TEXT)
      await error(r, code)
      expect(r.abort).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert').textContent).toBe(message('microphone_denied'))
      expect(flag()).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Japaneseの録音を停止' })).toBeNull()
      await end(r)
      await result(r, 'more')
      await error(r, 'aborted')
      await flush()
      expect(interpretCalls()).toHaveLength(0)
      expect(r.start).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert').textContent).not.toContain(message('recording_failed'))
      const rec = lastRecord()
      expect(rec.finishReason).toBe(code)
      expect(rec.finalTextLength).toBeNull()
      expect(rec.transcriptSent).toBe(false)
      expect(rec.interpretResult).toBeNull()
      expect(rec.events.filter(e => e.type === 'abort')).toHaveLength(1)
      expect(rec.events.filter(e => e.type === 'error').map(e => e.error)).toEqual([code, 'aborted'])
      expect(rec.events.find(e => e.type === 'end')?.phase).toBe('finished')
    })
  }

  it('discards on not-allowed while stopping', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    await tapStop()
    await error(r, 'not-allowed')
    await end(r)
    await flush()
    expect(interpretCalls()).toHaveLength(0)
    expect(lastRecord().finishReason).toBe('not-allowed')
    expect(r.abort).toHaveBeenCalledTimes(1)
  })

  it('discards on unmount: aborts once without sending or restarting', async () => {
    const { unmount } = renderRecogOnly()
    await tap()
    const r = recognition()
    await result(r, TEXT)
    unmount()
    expect(r.abort).toHaveBeenCalledTimes(1)
    r.onend?.()
    r.onresult?.({ results: [[{ transcript: 'x' }]] })
    await flush()
    expect(interpretCalls()).toHaveLength(0)
    expect(r.start).toHaveBeenCalledTimes(1)
    const rec = lastRecord()
    expect(rec.finishReason).toBe('unmount')
    expect(rec.finalTextLength).toBeNull()
    expect(rec.events.filter(e => e.type === 'abort')).toHaveLength(1)
    expect(eventTypes(rec)).toEqual(['start', 'result', 'abort', 'end', 'result'])
  })

  it('does nothing on unmount without an utterance', async () => {
    const { unmount } = renderRecogOnly()
    await utterance()
    unmount()
    expect(recognition().abort).not.toHaveBeenCalled()
    expect(lastRecord().finishReason).toBe('user-stop')
  })
})

describe('LegacyInterpreterPage with exp=recogonly: interpretResult', () => {
  const errorCases: { name: string; respond: () => Promise<Response>; result: string; key: MessageKey }[] = [
    {
      name: '422 language_mismatch',
      respond: () => Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({ error: 'language_mismatch' }) } as unknown as Response),
      result: 'language_mismatch', key: 'language_unclear',
    },
    {
      name: '503 upstream_busy',
      respond: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: 'busy', code: 'upstream_busy' }) } as unknown as Response),
      result: 'upstream_busy', key: 'upstream_busy',
    },
    {
      name: '500 without a code',
      respond: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response),
      result: 'status_500', key: 'generic_error',
    },
    {
      name: 'the frontend timeout',
      respond: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      result: 'frontend_timeout', key: 'request_timeout',
    },
    {
      name: 'a fetch exception',
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
      result: 'exception_TypeError', key: 'generic_error',
    },
  ]

  for (const c of errorCases) {
    it(`records ${c.result} for ${c.name} and shows the same message as legacy`, async () => {
      interpretResponse = c.respond
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      renderRecogOnly()
      await utterance()
      const rec = lastRecord()
      expect(rec.transcriptSent).toBe(true)
      expect(rec.interpretResult).toBe(c.result)
      expect(screen.getByRole('alert').textContent).toBe(message(c.key))
      expect(flag()).toBeEnabled()
    })
  }
})

describe('LegacyInterpreterPage with exp=recogonly: events and records', () => {
  it('records the six passive events', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    act(() => {
      r.onaudiostart?.(); r.onsoundstart?.(); r.onspeechstart?.(); r.onspeechend?.(); r.onsoundend?.(); r.onaudioend?.()
    })
    expect(eventTypes(lastRecord())).toEqual(['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend'])
  })

  it('keeps the events of the previous recognition in the previous record', async () => {
    renderRecogOnly()
    const first = await utterance()
    await tap()
    const second = recognition()
    expect(second).not.toBe(first)
    await result(second, 'こんにちは')
    await act(async () => {
      first.onresult?.({ results: [[{ transcript: 'ふるい' }]] })
      first.onerror?.({ error: 'aborted' })
      first.onend?.()
    })
    expect(shownText()).toBe('こんにちは')
    expect(first.start).toHaveBeenCalledTimes(1)
    const [r1, r2] = diagnostics().recordings
    expect(eventTypes(r1)).toEqual(['start', 'result', 'stop', 'end', 'result', 'error', 'end'])
    expect(r1.events[6].phase).toBe('finished')
    expect(eventTypes(r2)).toEqual(['start', 'result'])
    expect(r2.recordingNo).toBe(2)
  })

  it('keeps 300 events per utterance and counts the dropped ones', async () => {
    renderRecogOnly()
    await tap()
    const r = recognition()
    act(() => { for (let i = 0; i < 350; i++) r.onaudiostart?.() })
    const rec = lastRecord()
    expect(rec.events).toHaveLength(300)
    expect(rec.eventsDropped).toBe(51)
  })

  it('keeps the latest 20 utterances', async () => {
    renderRecogOnly()
    for (let i = 0; i < 21; i++) await utterance()
    const { recordings } = diagnostics()
    expect(recordings).toHaveLength(20)
    expect(recordings[0].recordingNo).toBe(2)
    expect(recordings[19].recordingNo).toBe(21)
    expect(recordings.every(r => r.finishReason === 'user-stop')).toBe(true)
  })

  it('returns a recogonly snapshot with copies', async () => {
    renderRecogOnly()
    await utterance()
    const snapshot = panel.read!() as Extract<ExperimentSnapshot, { kind: 'recogonly' }>
    expect(snapshot.kind).toBe('recogonly')
    expect(snapshot.effective).toEqual(['recogonly'])
    expect(snapshot.config.requested).toEqual(['recogonly'])
    snapshot.diagnostics.recordings[0].events.push({ type: 'abort', at: 0 })
    snapshot.diagnostics.recordings[0].restartErrors.push('x')
    snapshot.diagnostics.recognitionStarts.gesture = 99
    const fresh = diagnostics()
    expect(fresh.recordings[0].events).toHaveLength(4)
    expect(fresh.recordings[0].restartErrors).toEqual([])
    expect(fresh.recognitionStarts.gesture).toBe(1)
  })

  it('copies all the items as JSON and shows the recogonly view', async () => {
    renderRecogOnly()
    await utterance()
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (text: string) => { copied = text }) }, configurable: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const json = JSON.parse(copied) as { kind: string; diagnostics: RecogOnlyDiagnostics }
    expect(json.kind).toBe('recogonly')
    expect(Object.keys(json.diagnostics.recordings[0]).sort()).toEqual([
      'autoRestarts', 'endTimeoutFired', 'events', 'eventsDropped', 'finalTextLength', 'finishReason', 'finishedAt', 'interpretResult', 'lang',
      'recognitionCtorMissing', 'recordingNo', 'restartErrors', 'restartLimitReached', 'segments', 'silenceBeforeAutoEndMs', 'startCalledAt',
      'startError', 'stopCalledAt', 'stopError', 'stopToEndMs', 'transcriptSent', 'utteranceStartedAt',
    ])
    expect(json.diagnostics.ttsPlays).toEqual([])
    expect(json.diagnostics.recognitionStarts).toEqual({ gesture: 1, restart: 0 })
    fireEvent.click(screen.getByRole('button', { name: '更新' }))
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('（recogonly）')
    expect(screen.getByTestId('experiment-snapshot')).toHaveTextContent('終了=user-stop')
  })
})

describe('LegacyInterpreterPage with exp=recogonly: read aloud', () => {
  it('records RecogOnlyTtsPlay after the latest utterance', async () => {
    renderRecogOnly()
    await utterance()
    await utterance()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    await act(async () => { audios[0].onended?.() })
    const { ttsPlays } = diagnostics()
    expect(ttsPlays).toEqual([{ afterRecordingNo: 2, playCalledAt: expect.any(Number), playResult: 'resolved', ended: true, error: false }])
    // 読み上げの後も、次の発話を始められる
    await utterance()
    expect(lastRecord().interpretResult).toBe('ok')
  })

  it('records the play() exception and onerror', async () => {
    renderRecogOnly()
    await utterance()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const audioCtor = globalThis.Audio as unknown as { mockImplementationOnce: (f: () => FakeAudio) => void }
    audioCtor.mockImplementationOnce(function () {
      const audio: FakeAudio = { play: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')), pause: vi.fn(), onended: null, onerror: null }
      audios.push(audio)
      return audio
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    await act(async () => { audios[0].onerror?.() })
    expect(diagnostics().ttsPlays[0]).toMatchObject({ afterRecordingNo: 1, playResult: 'NotAllowedError', ended: false, error: true })
  })

  it('keeps the latest 10 plays', async () => {
    renderRecogOnly()
    await utterance()
    for (let i = 0; i < 11; i++) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
      await act(async () => { audios[audios.length - 1].onended?.() })
    }
    expect(diagnostics().ttsPlays).toHaveLength(10)
  })
})
