/// <reference types="node" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import InterpreterPage from './InterpreterPage'
import { MIN_INTERPRET_AUDIO_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { getLocalizedMessage } from '../messages'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'
import {
  AUDIO_GLOBALS, firePageTransition, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition, setVisibility,
} from '../test/audioMocks'

// 通訳の画面で、話さなくても最初から文字を入力して翻訳する（GOTALK-6、docs/ui.md）。
// 番号は、GOTALK-6 の設計の 5.8 のテストの番号。
// jsdom は、画面の上の位置から一番上の要素を選ぶこと（hit test）も pointer-events もしないので、tapAt() で、
// 「その位置をタップすると、一番上に重なっている要素に click が届く」ことを再現する

const AUDIO_DATA = 'a'.repeat(MIN_INTERPRET_AUDIO_BYTES)
const [ja, en] = LANGUAGES

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let recognitions: ReturnType<typeof setupSpeechRecognition>
let fetchMock: ReturnType<typeof vi.spyOn>
// /api/translate の応答（既定は成功）。null のときは、応答を返さずに待つ
let translateResponse: ((text: string) => Response) | null

function okJson(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

const translateOk = (text: string) => okJson({ translatedText: `訳:${text}`, backTranslation: `逆:${text}`, ttsText: `訳:${text}`, sourceLanguage: 'ja', targetLanguage: 'en' })

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  recognitions = setupSpeechRecognition()
  setupAudioContext()
  translateResponse = translateOk
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === '/api/tts') return makeTtsOkResponse()
    if (String(url) === '/api/translate') {
      const respond = translateResponse
      if (respond === null) return new Promise<Response>(() => {})
      const { text } = JSON.parse(String((options as RequestInit).body)) as { text: string }
      return respond(text)
    }
    return okJson({ text: 'こんにちは', translatedText: 'Hello', ttsText: 'Hello', backTranslation: '(こんにちは)', sourceLanguage: 'ja', targetLanguage: 'en' })
  })
})

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).activeElement
  cleanup()
  vi.restoreAllMocks()
  restoreGlobals()
})

function renderPage() {
  const onBack = vi.fn()
  const { unmount } = render(<InterpreterPage selectedLanguages={[ja, en]} onBack={onBack} />)
  return { onBack, unmount }
}

// textarea に blur の出来事を出さずに、フォーカスがない状態（document.activeElement が textarea でない）にする
// （iPhone が focus() を受け付けなかったとき、裏に回して戻ったときなど）。afterEach で元に戻す
function loseFocusWithoutBlur() {
  Object.defineProperty(document, 'activeElement', { get: () => document.body, configurable: true })
}

const editButton = () => document.querySelector<HTMLButtonElement>('.source-card__edit')!
const sourceCard = () => document.querySelector<HTMLElement>('.source-card')!
const sourceText = () => document.querySelector<HTMLElement>('.source-card__text')
const textarea = () => screen.queryByRole('textbox', { name: '原文を編集' }) as HTMLTextAreaElement | null
const editShield = () => document.querySelector<HTMLElement>('.edit-confirm-shield')
const flagButton = (lang: Language) => screen.getByRole('button', { name: new RegExp(`^${lang.label}(で話す|の録音を停止)$`) })
const translateCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/translate')
const ttsCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/tts')
const translationText = () => document.querySelector<HTMLElement>('.translation-card__text')?.textContent
const historySources = () => [...document.querySelectorAll('.history-item__source')].map(el => el.textContent)

// 画面のその位置をタップする。編集の間は、原文のカードの外へのタップは、透明な覆いに届く
// （原文のカードは覆いより上にある）。覆いの mousedown は既定の動き（フォーカスの移動）を止める。
// iPhone の Safari と同じく、押せない要素のタップでは blur は起きないものとする（確定は click の処理で行う）
function tapAt(el: Element) {
  const shield = editShield()
  const target = shield && !sourceCard().contains(el) ? shield : el
  const notPrevented = fireEvent.mouseDown(target)
  if (target === shield) expect(notPrevented).toBe(false)
  fireEvent.click(target)
}

async function tap(el: Element) {
  await act(async () => { tapAt(el) })
}

async function startEdit() {
  await act(async () => { fireEvent.click(editButton()) })
  expect(textarea()).not.toBeNull()
}

async function type(text: string) {
  await act(async () => { fireEvent.change(textarea()!, { target: { value: text } }) })
}

// 録音して止め、翻訳の結果（原文は「こんにちは」）を出して ready にする
async function reachReadyByRecording() {
  await act(async () => { fireEvent.click(flagButton(ja)) })
  await act(async () => { await gum.calls[0].resolve() })
  await act(async () => { recognitions.instances.at(-1)!.onresult?.({ results: [[{ transcript: 'こんにちは' }]] }) })
  await act(async () => { fireEvent.click(document.querySelector('.recording-overlay')!) })
  const recorder = recorders.instances.at(-1)!
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob([AUDIO_DATA]) })
    recorder.onstop?.()
  })
  expect(screen.getByRole('button', { name: '発声する' })).not.toBeDisabled()
}

describe('InterpreterPage text input: start (GOTALK-6 5.8)', () => {
  it('lets the empty source be typed from the start, with the focus moved during the tap (5.8-1)', async () => {
    renderPage()
    expect(sourceText()?.textContent).toBe('')
    expect(editButton()).not.toBeDisabled()
    expect(editButton()).toHaveAttribute('aria-label', '入力')
    // タップの処理の中（click の dispatch の間）で、textarea にフォーカスが移っている
    let focusedDuringTap: Element | null = null
    const onClick = () => { focusedDuringTap = document.activeElement }
    document.addEventListener('click', onClick)
    await startEdit()
    document.removeEventListener('click', onClick)
    expect(focusedDuringTap).toBe(textarea())
    expect(document.activeElement).toBe(textarea())
    expect(textarea()!.value).toBe('')
    expect(editShield()).not.toBeNull()
  })

  it('starts with the recognized text when there is one (5.8-2)', async () => {
    renderPage()
    await reachReadyByRecording()
    expect(editButton()).toHaveAttribute('aria-label', '編集')
    await startEdit()
    expect(textarea()!.value).toBe('こんにちは')
    expect(document.activeElement).toBe(textarea())
    expect(textarea()!.selectionStart).toBe('こんにちは'.length)
  })
})

describe('InterpreterPage text input: confirm (GOTALK-6 5.8)', () => {
  it('translates the typed text once when the shield is tapped (5.8-3)', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    await tap(editShield()!)
    expect(translateCalls()).toHaveLength(1)
    const body = JSON.parse(String((translateCalls()[0][1] as RequestInit).body)) as { text: string; languages: { id: string }[] }
    expect(body.text).toBe('駅はどこですか')
    expect(body.languages.map(l => l.id)).toEqual(['ja', 'en'])
    expect(textarea()).toBeNull()
    expect(sourceText()?.textContent).toBe('駅はどこですか')
    expect(translationText()).toBe('訳:駅はどこですか')
    expect(screen.getByText('逆:駅はどこですか')).toBeInTheDocument()
    expect(historySources()).toEqual(['駅はどこですか'])
  })

  it('does nothing but confirm when the shield over the flag, title or speak button is tapped (5.8-4)', async () => {
    const { onBack } = renderPage()
    // 国旗の上：確定して訳すが、録音は始まらない
    await startEdit()
    await type('駅はどこですか')
    await tap(flagButton(ja))
    expect(translateCalls()).toHaveLength(1)
    expect(gum.calls).toHaveLength(0)
    expect(recorders.instances).toHaveLength(0)
    expect(editShield()).toBeNull()
    // 題名の上：戻らない（同じ文字なので訳さない）
    await startEdit()
    await tap(screen.getByRole('button', { name: 'トップ画面へ戻る' }))
    expect(onBack).not.toHaveBeenCalled()
    expect(editShield()).toBeNull()
    // 読み上げのボタンの上：読み上げない
    await startEdit()
    await tap(screen.getByRole('button', { name: '発声する' }))
    expect(ttsCalls()).toHaveLength(0)
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
    // 確定の後は覆いがないので、国旗をタップすると録音が始まる
    await tap(flagButton(ja))
    expect(gum.calls).toHaveLength(1)
    expect(document.querySelector('.recording-overlay')).not.toBeNull()
  })

  it('does not call /api/translate for an empty or unchanged text (5.8-5)', async () => {
    renderPage()
    await startEdit()
    await type('   ')
    await tap(editShield()!)
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
    await reachReadyByRecording()
    await startEdit()
    await tap(editShield()!)
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
  })

  it('confirms with Enter, but not with the Enter that confirms the conversion of the input method (5.8-6)', async () => {
    renderPage()
    await startEdit()
    await type('えき')
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Enter', isComposing: true }) })
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Enter', keyCode: 229 }) })
    // Shift+Enter でも確定しない（UU4）
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Enter', shiftKey: true }) })
    expect(textarea()).not.toBeNull()
    expect(translateCalls()).toHaveLength(0)
    await type('駅')
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Enter' }) })
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
    expect(translationText()).toBe('訳:駅')
  })

  it('cancels with Escape without changing the source (5.8-7)', async () => {
    renderPage()
    await reachReadyByRecording()
    await startEdit()
    await type('別の文')
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Escape' }) })
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
    expect(sourceText()?.textContent).toBe('こんにちは')
  })

  it('confirms on blur, as when the keyboard is closed (5.8-8)', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    await act(async () => { textarea()!.blur() })
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
  })

  it('confirms when the pencil button position or the padding of the source card is tapped while editing (5.8-9)', async () => {
    renderPage()
    await startEdit()
    // 編集の間は、鉛筆のボタンをタップの対象から外す（タップは下の原文のカードに届く）
    expect(editButton()).toHaveClass('source-card__edit--editing')
    expect(editButton()).toBeDisabled()
    // vitest は CSS を読み込まない（getComputedStyle では見られない）ので、CSS の規則を文字として確かめる
    const css = readFileSync('src/pages/InterpreterPage.css', 'utf8')
    expect(css).toMatch(/\.source-card__edit--editing\s*\{[^}]*pointer-events:\s*none;/)
    await type('駅はどこですか')
    await tap(sourceCard())
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
    expect(editButton()).not.toHaveClass('source-card__edit--editing')
  })

  it('does not confirm when the textarea itself is tapped (5.8-10)', async () => {
    renderPage()
    await startEdit()
    await type('駅')
    await tap(textarea()!)
    expect(textarea()).not.toBeNull()
    expect(document.activeElement).toBe(textarea())
    expect(translateCalls()).toHaveLength(0)
  })
})

describe('InterpreterPage text input: states (GOTALK-6 5.8)', () => {
  it('does not let the button be pressed while recording or translating (5.8-11)', async () => {
    renderPage()
    await act(async () => { fireEvent.click(flagButton(ja)) })
    expect(editButton()).toBeDisabled()
    await act(async () => { await gum.calls[0].resolve() })
    expect(editButton()).toBeDisabled()
    await act(async () => { fireEvent.click(document.querySelector('.recording-overlay')!) })
    expect(editButton()).toBeDisabled()
    const recorder = recorders.instances.at(-1)!
    await act(async () => {
      recorder.ondataavailable?.({ data: new Blob([AUDIO_DATA]) })
      recorder.onstop?.()
    })
    expect(editButton()).not.toBeDisabled()
    // 打った文の翻訳を待っている間（processing）
    translateResponse = null
    await startEdit()
    await type('駅')
    await tap(editShield()!)
    expect(translationText()).toContain('ただいま翻訳中です')
    expect(editButton()).toBeDisabled()
  })

  it('shows the language_unclear message for language_mismatch (5.8-12)', async () => {
    translateResponse = () => ({ ok: false, status: 422, json: () => Promise.resolve({ error: 'language_mismatch' }) }) as unknown as Response
    renderPage()
    await startEdit()
    await type('Bonjour')
    await tap(editShield()!)
    expect(screen.getByRole('alert').textContent).toBe(getLocalizedMessage('language_unclear', 'ja', 'en'))
    expect(translationText()).toBe('')
    expect(editButton()).not.toBeDisabled()
  })
})

describe('InterpreterPage text input: confirm without the focus (PR #37 UU1)', () => {
  it('confirms by a shield tap when the textarea has lost the focus without blur', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    loseFocusWithoutBlur()
    await tap(editShield()!)
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
    expect(translationText()).toBe('訳:駅はどこですか')
  })

  it('closes without /api/translate when the text is empty', async () => {
    renderPage()
    await startEdit()
    loseFocusWithoutBlur()
    await tap(editShield()!)
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
  })

  it('confirms by a tap on the pencil button position of the source card when the textarea has lost the focus', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    loseFocusWithoutBlur()
    await tap(sourceCard())
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
  })

  it('calls /api/translate only once for a shield tap with the focus (blur and the direct call do not overlap)', async () => {
    renderPage()
    await startEdit()
    expect(document.activeElement).toBe(textarea())
    const blur = vi.spyOn(textarea()!, 'blur')
    await type('駅はどこですか')
    await tap(editShield()!)
    expect(blur).toHaveBeenCalledTimes(1)
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
  })
})

describe('InterpreterPage text input: interruptions (PR #37 UU2)', () => {
  it('keeps editing while hidden, and confirms by a shield tap after coming back', async () => {
    renderPage()
    await startEdit()
    await type('駅は')
    await act(async () => { setVisibility('hidden') })
    await act(async () => { setVisibility('visible') })
    expect(textarea()).not.toBeNull()
    expect(editShield()).not.toBeNull()
    expect(translateCalls()).toHaveLength(0)
    // もう一度打てる
    await type('駅はどこですか')
    expect(textarea()!.value).toBe('駅はどこですか')
    // 戻った後にフォーカスがなくても、覆いのタップで確定する
    loseFocusWithoutBlur()
    await tap(editShield()!)
    expect(textarea()).toBeNull()
    expect(translateCalls()).toHaveLength(1)
    expect(translationText()).toBe('訳:駅はどこですか')
  })

  it('cancels editing without /api/translate on pagehide, and nothing is left after pageshow', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    await act(async () => { firePageTransition('pagehide', true) })
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    await act(async () => { firePageTransition('pageshow', true) })
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
    expect(sourceText()?.textContent).toBe('')
    expect(editButton()).not.toBeDisabled()
  })

  it('cancels editing left over at pageshow (persisted)', async () => {
    renderPage()
    await startEdit()
    await type('駅はどこですか')
    // pagehide が来ないまま bfcache から戻った場合の守り
    await act(async () => { firePageTransition('pageshow', true) })
    expect(textarea()).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
  })

  it('leaves no editing state when the screen is unmounted', async () => {
    const { unmount } = renderPage()
    await startEdit()
    await type('駅はどこですか')
    await act(async () => { unmount() })
    expect(document.querySelector('.source-card__textarea')).toBeNull()
    expect(editShield()).toBeNull()
    expect(translateCalls()).toHaveLength(0)
  })

  it('stops speaking and keeps editing when hidden while editing during speaking', async () => {
    renderPage()
    await reachReadyByRecording()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '発声する' })) })
    const speakButton = screen.getByRole('button', { name: '発声する' })
    expect(speakButton).toHaveClass('speak-icon-button--speaking')
    // speaking の間に編集を始める（読み上げは確定まで止めない）
    await startEdit()
    expect(speakButton).toHaveClass('speak-icon-button--speaking')
    await act(async () => { setVisibility('hidden') })
    // 読み上げは止まって ready になり、編集は続いている
    expect(speakButton).not.toHaveClass('speak-icon-button--speaking')
    expect(speakButton).not.toBeDisabled()
    expect(textarea()).not.toBeNull()
    expect(editShield()).not.toBeNull()
    expect(textarea()!.value).toBe('こんにちは')
  })
})
