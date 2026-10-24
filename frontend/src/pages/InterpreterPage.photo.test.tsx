/// <reference types="node" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import InterpreterPage from './InterpreterPage'
import { MAX_UPLOAD_BYTES } from '../api'
import { resetKeptMicForTest } from '../audio/keptMic'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'
import {
  AUDIO_GLOBALS, firePageTransition, makeTtsOkResponse, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder,
  setupSpeechRecognition, setVisibility,
} from '../test/audioMocks'
import type { AudioSession } from '../hooks/useAudioSession'

// 通訳の画面で、カメラで撮った文字を翻訳する（GOTALK-7、docs/ui.md）。
// createImageBitmap、canvas の getContext と toBlob は偽物にし、/api/photo の fetch も偽物にする。
// 画面の状態は、録音のセッションの診断の出来事（status:…）で確かめる（InterpreterPage.textInput.test.tsx と同じ）
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

const lastStatus = () => captured.session!.getDiagnostics().events.map(e => e.type).filter(t => t.startsWith('status:')).at(-1)

const [ja, en] = LANGUAGES
const th = LANGUAGES.find(l => l.id === 'th')!
const vi_ = LANGUAGES.find(l => l.id === 'vi')!

// ─── 偽の createImageBitmap と canvas ─────────────────────────────────────────

interface FakeBitmap { width: number; height: number; close: ReturnType<typeof vi.fn> }
interface ToBlobCall { quality: number | undefined; type: string | undefined; width: number; height: number }

let bitmaps: FakeBitmap[]
// createImageBitmap の結果（既定は 4000×3000 の写真）。テストが置き換える
let createImageBitmapImpl: (file: Blob, options: unknown) => Promise<FakeBitmap>
let createImageBitmapMock: ReturnType<typeof vi.fn>
let canvases: HTMLCanvasElement[]
let drawImage: ReturnType<typeof vi.fn>
let toBlobCalls: ToBlobCall[]
// toBlob が返す JPEG の大きさ（品質ごと）。null を返すと toBlob が null を渡す。'throw' なら例外を出す
let toBlobSize: (quality: number | undefined) => number | null | 'throw'

function bitmapOf(width: number, height: number): FakeBitmap {
  const bitmap = { width, height, close: vi.fn() }
  bitmaps.push(bitmap)
  return bitmap
}

// 終わらせ方をテストが決める Promise
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ─── fetch ───────────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.spyOn>
// /api/photo の応答。null のときは、abort されるまで応答を返さない
let photoResponse: (() => Promise<Response>) | null

function okJson(body: object): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

function errorJson(status: number, code: string): Response {
  return { ok: false, status, json: () => Promise.resolve({ error: 'x', code }) } as unknown as Response
}

const PHOTO_OK = {
  lines: [
    { source: 'ข้าวผัด', translation: 'チャーハン', sourceLanguage: 'other', targetLanguage: 'ja' },
    { source: 'ラーメン', translation: 'Ramen', sourceLanguage: 'ja', targetLanguage: 'en' },
    { source: 'Coffee', translation: 'コーヒー', sourceLanguage: 'en', targetLanguage: 'ja' },
  ],
  sourceText: 'ข้าวผัด\nラーメン\nCoffee',
  translatedText: 'チャーハン\nRamen\nコーヒー',
  ttsText: 'チャーハン\nRamen\nコーヒー',
  primarySourceLanguage: 'ja',
  primaryTargetLanguage: 'ja',
}

function pendingUntilAborted(options?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let inputClick: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error')
  restoreGlobals = saveGlobals([...AUDIO_GLOBALS, [globalThis, 'createImageBitmap']])
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
  setupMediaRecorder()
  setupSpeechRecognition()
  setupAudioContext()

  bitmaps = []
  canvases = []
  toBlobCalls = []
  createImageBitmapImpl = async () => bitmapOf(4000, 3000)
  createImageBitmapMock = vi.fn((file: Blob, options: unknown) => createImageBitmapImpl(file, options))
  Object.defineProperty(globalThis, 'createImageBitmap', { value: createImageBitmapMock, writable: true, configurable: true })
  drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push(this)
    return { drawImage } as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])
  toBlobSize = () => 200_000
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, quality?: number) {
    toBlobCalls.push({ quality, type, width: this.width, height: this.height })
    const size = toBlobSize(quality)
    if (size === 'throw') throw new DOMException('insecure', 'SecurityError')
    // 呼ぶ側の Promise と同じく、後から callback を呼ぶ
    queueMicrotask(() => cb(size === null ? null : new Blob([new Uint8Array(size)], { type })))
  })
  // 写真を選ぶ画面は開かない（click() が呼ばれたことだけを確かめる）
  inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

  photoResponse = () => Promise.resolve(okJson(PHOTO_OK))
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === '/api/tts') return makeTtsOkResponse()
    if (String(url) === '/api/translate') {
      const { text } = JSON.parse(String((options as RequestInit).body)) as { text: string }
      return okJson({ translatedText: `訳:${text}`, backTranslation: `逆:${text}`, ttsText: `訳:${text}`, sourceLanguage: 'ja', targetLanguage: 'en' })
    }
    if (String(url) === '/api/photo') {
      if (photoResponse === null) return pendingUntilAborted(options as RequestInit)
      return photoResponse()
    }
    return okJson({ text: 'こんにちは', translatedText: 'Hello', ttsText: 'Hello', backTranslation: '(こんにちは)', sourceLanguage: 'ja', targetLanguage: 'en' })
  })
})

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).activeElement
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  restoreGlobals()
})

function renderPage(languages: Language[] = [ja, en]) {
  const onBack = vi.fn()
  const { unmount } = render(<InterpreterPage selectedLanguages={languages} onBack={onBack} />)
  return { onBack, unmount }
}

const cameraButton = () => screen.getByRole('button', { name: '写真から翻訳' })
const editButton = () => document.querySelector<HTMLButtonElement>('.source-card__edit')!
const sourceCard = () => document.querySelector<HTMLElement>('.source-card')!
const sourceText = () => document.querySelector<HTMLElement>('.source-card__text')?.textContent
const photoInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!
const textarea = () => screen.queryByRole('textbox', { name: '原文を編集' }) as HTMLTextAreaElement | null
const flagButton = (lang: Language) => screen.getByRole('button', { name: new RegExp(`^${lang.label}(で話す|の録音を停止)$`) })
const speakButton = () => screen.queryByRole('button', { name: '発声する' })
const photoCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/photo')
const ttsCalls = () => fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]) === '/api/tts')
const photoForm = (i = 0) => (photoCalls()[i][1] as RequestInit).body as FormData
const alertText = () => screen.queryByRole('alert')?.textContent ?? null
const photoLineTexts = () => [...document.querySelectorAll('.photo-lines__item')].map(el => [
  el.querySelector('.photo-lines__source')?.textContent, el.querySelector('.photo-lines__translation')?.textContent,
])
const backTranslationSection = () => document.querySelector('.back-translation-section')
const historyItems = () => [...document.querySelectorAll('.history-item')].map(el => ({
  date: el.querySelector('.history-item__date')?.textContent,
  source: el.querySelector('.history-item__source')?.textContent,
  translation: el.querySelector('.history-item__translation')?.textContent,
}))
const message = (key: MessageKey, a = 'ja', b = 'en') => getLocalizedMessage(key, a, b)
const css = () => readFileSync('src/pages/InterpreterPage.css', 'utf8')

function photoFile(name = 'IMG_0001.HEIC') {
  return new File([new Uint8Array(10)], name, { type: 'image/heic' })
}

// 写真を選ぶ（選ぶ画面で写真が選ばれ、change が来る）。処理は待たない
function selectPhoto(file: File = photoFile()) {
  fireEvent.change(photoInput(), { target: { files: [file] } })
}

// 写真を選び、前処理と問い合わせが終わるまで待つ
async function selectPhotoAndWait(file?: File) {
  await act(async () => { selectPhoto(file) })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

// 写真の翻訳の結果を出して ready にする
async function reachReadyByPhoto() {
  await selectPhotoAndWait()
  expect(lastStatus()).toBe('status:ready')
}

describe('InterpreterPage photo: camera button (GOTALK-7 6.1.1)', () => {
  it('puts the camera button at the left end of the source card and opens the picker during the tap', async () => {
    renderPage()
    expect(sourceCard().firstElementChild).toBe(cameraButton())
    expect(cameraButton()).toHaveClass('source-card__camera')
    expect(cameraButton()).not.toBeDisabled()
    // vitest は CSS を読み込まないので、CSS の規則を文字として確かめる
    expect(css()).toMatch(/\.source-card\s*\{[^}]*padding:\s*20px 56px;/)
    expect(css()).toMatch(/\.source-card__camera\s*\{[^}]*left:\s*8px;[^}]*width:\s*44px;[^}]*height:\s*44px;/)
    expect(css()).toMatch(/\.source-card__camera\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/)
    // 写真を選ぶ画面（capture なし）
    expect(photoInput().accept).toBe('image/*')
    expect(photoInput().hasAttribute('capture')).toBe(false)
    let clickedDuringTap = false
    const onClick = () => { clickedDuringTap = inputClick.mock.calls.length > 0 }
    document.addEventListener('click', onClick)
    await act(async () => { fireEvent.click(cameraButton()) })
    document.removeEventListener('click', onClick)
    expect(inputClick).toHaveBeenCalledTimes(1)
    expect(inputClick.mock.contexts[0]).toBe(photoInput())
    expect(clickedDuringTap).toBe(true)
  })

  it('can be pressed only in idle and ready', async () => {
    renderPage()
    expect(cameraButton()).not.toBeDisabled()
    // ready
    await reachReadyByPhoto()
    expect(cameraButton()).not.toBeDisabled()
    // speaking
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(lastStatus()).toBe('status:speaking')
    expect(cameraButton()).toBeDisabled()
  })

  it('cannot be pressed while starting to record or while recording', async () => {
    renderPage()
    await act(async () => { fireEvent.click(flagButton(ja)) })
    expect(lastStatus()).toBe('status:starting')
    expect(cameraButton()).toBeDisabled()
    await act(async () => { await gum.calls[0].resolve() })
    expect(lastStatus()).toBe('status:recording')
    expect(cameraButton()).toBeDisabled()
  })

  it('confirms the edit and does not open the picker when its position is tapped while editing', async () => {
    renderPage()
    await act(async () => { fireEvent.click(editButton()) })
    expect(textarea()).not.toBeNull()
    expect(cameraButton()).toBeDisabled()
    expect(cameraButton()).toHaveClass('source-card__camera--editing')
    expect(css()).toMatch(/\.source-card__camera--editing\s*\{[^}]*pointer-events:\s*none;/)
    await act(async () => { fireEvent.change(textarea()!, { target: { value: '駅はどこですか' } }) })
    // jsdom は pointer-events をしないので、その位置のタップが届く原文のカードをタップする
    await act(async () => { fireEvent.mouseDown(sourceCard()); fireEvent.click(sourceCard()) })
    expect(textarea()).toBeNull()
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]) === '/api/translate')).toHaveLength(1)
    expect(inputClick).not.toHaveBeenCalled()
    expect(cameraButton()).not.toHaveClass('source-card__camera--editing')
  })

  it('does nothing when the picker is canceled (no file)', async () => {
    renderPage()
    await act(async () => { fireEvent.change(photoInput(), { target: { files: [] } }) })
    expect(createImageBitmapMock).not.toHaveBeenCalled()
    expect(lastStatus()).toBeUndefined()
  })

  it('empties the input after taking the file, so that the same photo can be selected again', async () => {
    renderPage()
    const input = photoInput()
    const values: string[] = []
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: (v: string) => { values.push(v) } })
    const file = photoFile()
    await selectPhotoAndWait(file)
    expect(values).toEqual([''])
    await selectPhotoAndWait(file)
    expect(values).toEqual(['', ''])
    expect(photoCalls()).toHaveLength(2)
  })
})

describe('InterpreterPage photo: preprocessing (GOTALK-7 6.1.2)', () => {
  it('opens the photo with its orientation, shrinks the long side to 1280px, and sends a JPEG of quality 0.8', async () => {
    renderPage()
    const file = photoFile()
    await selectPhotoAndWait(file)
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
    expect(createImageBitmapMock.mock.calls[0]).toEqual([file, { imageOrientation: 'from-image' }])
    expect(drawImage).toHaveBeenCalledWith(bitmaps[0], 0, 0, 1280, 960)
    expect(toBlobCalls).toEqual([{ quality: 0.8, type: 'image/jpeg', width: 1280, height: 960 }])
    expect(photoCalls()).toHaveLength(1)
    const [, options] = photoCalls()[0] as [string, RequestInit]
    expect(options.method).toBe('POST')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    const form = photoForm()
    expect([...form.keys()].sort()).toEqual(['image', 'languages'])
    const image = form.get('image') as File
    expect(image.name).toBe('photo.jpg')
    expect(image.type).toBe('image/jpeg')
    expect(image.size).toBe(200_000)
    expect(JSON.parse(form.get('languages') as string)).toEqual([{ id: 'ja', label: ja.label }, { id: 'en', label: en.label }])
    // 片付け
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(canvases[0].width).toBe(0)
    expect(canvases[0].height).toBe(0)
  })

  it('sends the languages in the selected order', async () => {
    renderPage([en, ja])
    await selectPhotoAndWait()
    expect(JSON.parse(photoForm().get('languages') as string).map((l: { id: string }) => l.id)).toEqual(['en', 'ja'])
  })

  it('shrinks a portrait photo by its long side, and does not enlarge a small photo', async () => {
    renderPage()
    createImageBitmapImpl = async () => bitmapOf(3024, 4032)
    await selectPhotoAndWait()
    expect(toBlobCalls[0]).toMatchObject({ width: 960, height: 1280 })
    createImageBitmapImpl = async () => bitmapOf(640, 480)
    await selectPhotoAndWait()
    expect(toBlobCalls[1]).toMatchObject({ width: 640, height: 480 })
  })

  it('makes the JPEG again once with quality 0.6 when it is over the limit', async () => {
    renderPage()
    toBlobSize = q => (q === 0.8 ? MAX_UPLOAD_BYTES + 1 : MAX_UPLOAD_BYTES)
    await selectPhotoAndWait()
    expect(toBlobCalls.map(c => c.quality)).toEqual([0.8, 0.6])
    expect(photoCalls()).toHaveLength(1)
    expect((photoForm().get('image') as File).size).toBe(MAX_UPLOAD_BYTES)
  })

  it('does not send a photo still over the limit with quality 0.6, and shows photo_too_large', async () => {
    renderPage()
    toBlobSize = () => MAX_UPLOAD_BYTES + 1
    await selectPhotoAndWait()
    expect(toBlobCalls.map(c => c.quality)).toEqual([0.8, 0.6])
    expect(photoCalls()).toHaveLength(0)
    expect(alertText()).toBe(message('photo_too_large'))
    expect(lastStatus()).toBe('status:idle')
    expect(bitmaps[0].close).toHaveBeenCalled()
    expect(canvases[0].width).toBe(0)
  })

  it('is processing during the preprocessing, with the flags, pencil, camera and speak buttons not pressable', async () => {
    renderPage()
    await reachReadyByPhoto()
    expect(speakButton()).not.toBeNull()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    expect(lastStatus()).toBe('status:processing')
    expect(flagButton(ja)).toBeDisabled()
    expect(flagButton(en)).toBeDisabled()
    expect(editButton()).toBeDisabled()
    expect(cameraButton()).toBeDisabled()
    // 前の結果を残さない（読み上げのボタンも消える）
    expect(speakButton()).toBeNull()
    expect(sourceText()).toBe('')
    expect(photoLineTexts()).toEqual([])
    expect(document.querySelector('.translation-card__text--processing')).not.toBeNull()
    // processing の間に届いた2回目の写真は受け付けない
    await act(async () => { selectPhoto() })
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve(bitmapOf(800, 600)) })
    await waitFor(() => expect(lastStatus()).toBe('status:ready'))
    expect(photoCalls()).toHaveLength(2)
  })

  it('shows photo_load_failed when createImageBitmap fails, toBlob fails or gives null, and still cleans up', async () => {
    renderPage()
    createImageBitmapImpl = () => Promise.reject(new DOMException('cannot decode', 'InvalidStateError'))
    await selectPhotoAndWait()
    expect(alertText()).toBe(message('photo_load_failed'))
    expect(lastStatus()).toBe('status:idle')

    createImageBitmapImpl = async () => bitmapOf(4000, 3000)
    toBlobSize = () => null
    await selectPhotoAndWait()
    expect(alertText()).toBe(message('photo_load_failed'))
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(canvases[0].width).toBe(0)
    expect(canvases[0].height).toBe(0)

    toBlobSize = () => 'throw'
    await selectPhotoAndWait()
    expect(alertText()).toBe(message('photo_load_failed'))
    expect(bitmaps[1].close).toHaveBeenCalledTimes(1)
    expect(canvases[1].width).toBe(0)

    expect(photoCalls()).toHaveLength(0)
    expect(lastStatus()).toBe('status:idle')
  })

  it('shows generic_error, not photo_load_failed, for a network failure of /api/photo', async () => {
    renderPage()
    photoResponse = () => Promise.reject(new TypeError('Failed to fetch'))
    await selectPhotoAndWait()
    expect(alertText()).toBe(message('generic_error'))
    expect(lastStatus()).toBe('status:idle')
  })
})

describe('InterpreterPage photo: interruptions (GOTALK-7 6.1.2, 6.1.3)', () => {
  it('does not send to /api/photo after pagehide during the preprocessing', async () => {
    renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    await act(async () => { firePageTransition('pagehide', true) })
    expect(lastStatus()).toBe('status:idle')
    await act(async () => { pending.resolve(bitmapOf(4000, 3000)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(photoCalls()).toHaveLength(0)
    expect(toBlobCalls).toHaveLength(0)
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toBe('status:idle')
    expect(alertText()).toBeNull()
  })

  it('does not send to /api/photo after pagehide while making the JPEG', async () => {
    renderPage()
    const blob = deferred<void>()
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      void blob.promise.then(() => cb(new Blob([new Uint8Array(10)], { type })))
    })
    await act(async () => { selectPhoto() })
    await act(async () => { firePageTransition('pagehide', false) })
    await act(async () => { blob.resolve() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(photoCalls()).toHaveLength(0)
    expect(canvases[0].width).toBe(0)
    expect(lastStatus()).toBe('status:idle')
  })

  it('does not show photo_load_failed nor change the state when createImageBitmap fails after pagehide', async () => {
    renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    await act(async () => { firePageTransition('pagehide', true) })
    const statusEvents = captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length
    await act(async () => { pending.reject(new DOMException('cannot decode', 'InvalidStateError')) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(alertText()).toBeNull()
    expect(lastStatus()).toBe('status:idle')
    expect(captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length).toBe(statusEvents)
  })

  it('does not send nor change anything when the screen is left (back) during the preprocessing', async () => {
    const { onBack } = renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' })) })
    expect(onBack).toHaveBeenCalled()
    await act(async () => { pending.resolve(bitmapOf(4000, 3000)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(photoCalls()).toHaveLength(0)
    expect(lastStatus()).toBe('status:processing')
    expect(alertText()).toBeNull()
  })

  // 戻った後に前処理が失敗しても、文言も状態も変えない（PR #39 の WW2）
  it('does not show photo_load_failed nor change the state when the preprocessing fails after back', async () => {
    const { onBack } = renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' })) })
    expect(onBack).toHaveBeenCalled()
    const statusEvents = captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length
    await act(async () => { pending.reject(new DOMException('cannot decode', 'InvalidStateError')) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(photoCalls()).toHaveLength(0)
    expect(alertText()).toBeNull()
    expect(captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length).toBe(statusEvents)
  })

  // bfcache から戻った後（pagehide → pageshow の persisted）に新しい写真を始めてから、古い処理が終わる場合（PR #39 の WW2）。
  // 古い処理の結果、失敗、片付け（endRequest）が、新しい処理の状態、文言、有効な問い合わせの番号を妨げないこと
  describe('when an old photo finishes after pagehide, pageshow (persisted) and a new photo', () => {
    // createImageBitmap と /api/photo の呼び出しごとに、終わらせ方をテストが決める
    let bitmapCalls: ReturnType<typeof deferred<FakeBitmap>>[]
    let photoCallsPending: ReturnType<typeof deferred<Response>>[]
    const NEW_RESULT = { ...PHOTO_OK, lines: [PHOTO_OK.lines[1]], sourceText: 'ラーメン', translatedText: 'Ramen', ttsText: 'Ramen' }
    const OLD_RESULT = { ...PHOTO_OK, lines: [PHOTO_OK.lines[2]], sourceText: 'Coffee', translatedText: 'コーヒー', ttsText: 'コーヒー' }

    beforeEach(() => {
      bitmapCalls = []
      photoCallsPending = []
      createImageBitmapImpl = () => {
        const d = deferred<FakeBitmap>()
        bitmapCalls.push(d)
        return d.promise
      }
      photoResponse = () => {
        const d = deferred<Response>()
        photoCallsPending.push(d)
        return d.promise
      }
    })

    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // 写真を選び、pagehide と pageshow（persisted）を起こしてから、新しい写真を選ぶ
    async function leaveAndComeBackThenSelectNewPhoto() {
      await act(async () => { firePageTransition('pagehide', true) })
      expect(lastStatus()).toBe('status:idle')
      await act(async () => { firePageTransition('pageshow', true) })
      expect(lastStatus()).toBe('status:idle')
      expect(cameraButton()).not.toBeDisabled()
      await act(async () => { selectPhoto() })
      expect(lastStatus()).toBe('status:processing')
    }

    // 新しい処理を終わらせ、その結果が出ること（新しい処理の番号が有効なまま）を確かめる
    async function finishNewPhoto(bitmapIndex: number) {
      await act(async () => { bitmapCalls[bitmapIndex].resolve(bitmapOf(800, 600)) })
      await settle()
      expect(photoCalls()).toHaveLength(1)
      await act(async () => { photoCallsPending[0].resolve(okJson(NEW_RESULT)) })
      await settle()
      expect(lastStatus()).toBe('status:ready')
      expect(sourceText()).toBe('ラーメン')
      expect(photoLineTexts()).toEqual([['ラーメン', 'Ramen']])
      expect(alertText()).toBeNull()
      expect(historyItems().map(h => h.source)).toEqual(['ラーメン'])
    }

    it('ignores the old preprocessing that completes', async () => {
      renderPage()
      await act(async () => { selectPhoto() })
      await leaveAndComeBackThenSelectNewPhoto()
      // 古い前処理が終わる：送らず、新しい処理の processing のまま
      await act(async () => { bitmapCalls[0].resolve(bitmapOf(4000, 3000)) })
      await settle()
      expect(photoCalls()).toHaveLength(0)
      expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
      expect(lastStatus()).toBe('status:processing')
      await finishNewPhoto(1)
    })

    it('ignores the old preprocessing that fails', async () => {
      renderPage()
      await act(async () => { selectPhoto() })
      await leaveAndComeBackThenSelectNewPhoto()
      await act(async () => { bitmapCalls[0].reject(new DOMException('cannot decode', 'InvalidStateError')) })
      await settle()
      expect(alertText()).toBeNull()
      expect(lastStatus()).toBe('status:processing')
      await finishNewPhoto(1)
    })

    it('ignores the old request that succeeds or fails', async () => {
      for (const finishOld of [
        (d: ReturnType<typeof deferred<Response>>) => d.resolve(okJson(OLD_RESULT)),
        (d: ReturnType<typeof deferred<Response>>) => d.reject(new TypeError('Failed to fetch')),
      ]) {
        cleanup()
        bitmapCalls = []
        photoCallsPending = []
        fetchMock.mockClear()
        renderPage()
        await act(async () => { selectPhoto() })
        await act(async () => { bitmapCalls[0].resolve(bitmapOf(4000, 3000)) })
        await settle()
        expect(photoCalls()).toHaveLength(1)
        const oldSignal = (photoCalls()[0][1] as RequestInit).signal!
        await leaveAndComeBackThenSelectNewPhoto()
        expect(oldSignal.aborted).toBe(true)
        // 古い問い合わせが終わる（止めた後に応答や失敗が届く）：新しい処理の processing のまま
        await act(async () => { finishOld(photoCallsPending[0]) })
        await settle()
        expect(alertText()).toBeNull()
        expect(sourceText()).toBe('')
        expect(lastStatus()).toBe('status:processing')
        // 新しい処理を終わらせる
        await act(async () => { bitmapCalls[1].resolve(bitmapOf(800, 600)) })
        await settle()
        expect(photoCalls()).toHaveLength(2)
        const newSignal = (photoCalls()[1][1] as RequestInit).signal!
        expect(newSignal.aborted).toBe(false)
        await act(async () => { photoCallsPending[1].resolve(okJson(NEW_RESULT)) })
        await settle()
        expect(lastStatus()).toBe('status:ready')
        expect(sourceText()).toBe('ラーメン')
        expect(photoLineTexts()).toEqual([['ラーメン', 'Ramen']])
        expect(alertText()).toBeNull()
      }
    })

    // 古い処理の片付けが、新しい処理の番号を空にしないこと：新しい処理の途中の pagehide で、新しい問い合わせが止まる
    it('keeps the new request active after the old one is cleaned up', async () => {
      renderPage()
      await act(async () => { selectPhoto() })
      await leaveAndComeBackThenSelectNewPhoto()
      await act(async () => { bitmapCalls[0].reject(new DOMException('cannot decode', 'InvalidStateError')) })
      await settle()
      await act(async () => { bitmapCalls[1].resolve(bitmapOf(800, 600)) })
      await settle()
      expect(photoCalls()).toHaveLength(1)
      const newSignal = (photoCalls()[0][1] as RequestInit).signal!
      await act(async () => { firePageTransition('pagehide', true) })
      expect(newSignal.aborted).toBe(true)
      expect(lastStatus()).toBe('status:idle')
    })
  })

  it('does not send, change the state or warn when unmounted during the preprocessing, even if it then fails', async () => {
    const { unmount } = renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    const statusEvents = captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length
    unmount()
    await act(async () => { pending.reject(new DOMException('cannot decode', 'InvalidStateError')) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(photoCalls()).toHaveLength(0)
    expect(captured.session!.getDiagnostics().events.filter(e => e.type.startsWith('status:')).length).toBe(statusEvents)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('continues the preprocessing and the request when the page is hidden', async () => {
    renderPage()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    const response = deferred<Response>()
    photoResponse = () => response.promise
    await act(async () => { selectPhoto() })
    await act(async () => { setVisibility('hidden') })
    expect(lastStatus()).toBe('status:processing')
    await act(async () => { pending.resolve(bitmapOf(4000, 3000)) })
    await waitFor(() => expect(photoCalls()).toHaveLength(1))
    await act(async () => { setVisibility('hidden') })
    expect((photoCalls()[0][1] as RequestInit).signal!.aborted).toBe(false)
    await act(async () => { setVisibility('visible') })
    await act(async () => { response.resolve(okJson(PHOTO_OK)) })
    await waitFor(() => expect(lastStatus()).toBe('status:ready'))
    expect(sourceText()).toBe(PHOTO_OK.sourceText)
  })

  it('does not show a message when /api/photo fails after pagehide', async () => {
    renderPage()
    photoResponse = null
    await act(async () => { selectPhoto() })
    await waitFor(() => expect(photoCalls()).toHaveLength(1))
    const signal = (photoCalls()[0][1] as RequestInit).signal!
    await act(async () => { firePageTransition('pagehide', true) })
    expect(signal.aborted).toBe(true)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(alertText()).toBeNull()
    expect(lastStatus()).toBe('status:idle')
  })

  it('aborts /api/photo after 65 seconds from the send, and shows request_timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage([th, vi_])
    photoResponse = null
    await act(async () => { selectPhoto() })
    await waitFor(() => expect(photoCalls()).toHaveLength(1))
    const signal = (photoCalls()[0][1] as RequestInit).signal!
    await act(async () => { vi.advanceTimersByTime(64_000) })
    expect(signal.aborted).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(signal.aborted).toBe(true)
    await waitFor(() => expect(alertText()).toBe(message('request_timeout', 'th', 'vi')))
    expect(lastStatus()).toBe('status:idle')
  })
})

describe('InterpreterPage photo: errors of /api/photo (GOTALK-7 6.1.3)', () => {
  const cases: [string, () => Response, MessageKey][] = [
    ['no_text_found (422)', () => errorJson(422, 'no_text_found'), 'no_text_found'],
    ['photo_too_much_text (422)', () => errorJson(422, 'photo_too_much_text'), 'photo_too_much_text'],
    ['413 from the backend', () => errorJson(413, 'input_too_large'), 'photo_too_large'],
    ['413 from nginx (HTML)', () => ({ ok: false, status: 413, json: () => Promise.reject(new SyntaxError('html')) }) as unknown as Response, 'photo_too_large'],
    ['504 timeout', () => errorJson(504, 'timeout'), 'timeout'],
    ['502 upstream_error', () => errorJson(502, 'upstream_error'), 'generic_error'],
  ]
  for (const [name, respond, key] of cases) {
    it(`shows ${key} in the two selected languages for ${name}`, async () => {
      renderPage([th, vi_])
      photoResponse = () => Promise.resolve(respond())
      await selectPhotoAndWait()
      expect(alertText()).toBe(message(key, 'th', 'vi'))
      expect(lastStatus()).toBe('status:idle')
      expect(sourceText()).toBe('')
    })
  }
})

describe('InterpreterPage photo: result (GOTALK-7 6.1.3 to 6.1.5)', () => {
  it('shows the lines in pairs without the back translation, reads ttsText aloud, and adds one history entry', async () => {
    renderPage()
    await reachReadyByPhoto()
    expect(sourceText()).toBe(PHOTO_OK.sourceText)
    expect(photoLineTexts()).toEqual(PHOTO_OK.lines.map(l => [l.source, l.translation]))
    expect(backTranslationSection()).toBeNull()
    expect(document.querySelector('.translation-card__text')).toBeNull()
    expect(css()).toMatch(/\.photo-lines__translation\s*\{[^}]*font-size:\s*22px;/)
    expect(historyItems()).toHaveLength(1)
    expect(historyItems()[0]).toMatchObject({ source: PHOTO_OK.sourceText, translation: PHOTO_OK.translatedText })
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(ttsCalls()).toHaveLength(1)
    expect(JSON.parse(String((ttsCalls()[0][1] as RequestInit).body))).toEqual({ text: PHOTO_OK.ttsText })
  })

  it('shows the date of the history in the target language when the source language is other', async () => {
    renderPage()
    photoResponse = () => Promise.resolve(okJson({ ...PHOTO_OK, primarySourceLanguage: 'other', primaryTargetLanguage: 'en' }))
    await reachReadyByPhoto()
    const now = new Date()
    expect(historyItems()[0].date).toBe(now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    photoResponse = () => Promise.resolve(okJson({ ...PHOTO_OK, primarySourceLanguage: 'ja', primaryTargetLanguage: 'en' }))
    await reachReadyByPhoto()
    expect(historyItems()[0].date).toBe(now.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }))
  })

  it('shows the too long message for a ttsText over 500 characters', async () => {
    renderPage()
    const long = 'あ'.repeat(501)
    photoResponse = () => Promise.resolve(okJson({ ...PHOTO_OK, translatedText: long, ttsText: long }))
    await reachReadyByPhoto()
    await act(async () => { fireEvent.click(speakButton()!) })
    expect(ttsCalls()).toHaveLength(0)
    expect(alertText()).toBe(message('tts_too_long'))
  })

  it('clears the lines when a flag is tapped', async () => {
    renderPage()
    await reachReadyByPhoto()
    await act(async () => { fireEvent.click(flagButton(ja)) })
    expect(photoLineTexts()).toEqual([])
  })

  it('translates the edited source again with /api/translate and shows the normal translation with the back translation', async () => {
    renderPage()
    await reachReadyByPhoto()
    await act(async () => { fireEvent.click(editButton()) })
    expect(textarea()!.value).toBe(PHOTO_OK.sourceText)
    await act(async () => { fireEvent.change(textarea()!, { target: { value: 'ラーメン' } }) })
    await act(async () => { fireEvent.keyDown(textarea()!, { key: 'Enter' }) })
    await waitFor(() => expect(lastStatus()).toBe('status:ready'))
    expect(photoLineTexts()).toEqual([])
    expect(document.querySelector('.translation-card__text')?.textContent).toBe('訳:ラーメン')
    expect(backTranslationSection()).not.toBeNull()
    expect(screen.getByText('逆:ラーメン')).toBeInTheDocument()
  })

  it('clears the lines when the next photo starts', async () => {
    renderPage()
    await reachReadyByPhoto()
    const pending = deferred<FakeBitmap>()
    createImageBitmapImpl = () => pending.promise
    await act(async () => { selectPhoto() })
    expect(photoLineTexts()).toEqual([])
    expect(alertText()).toBeNull()
  })
})
