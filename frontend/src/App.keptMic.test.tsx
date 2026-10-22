import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import App from './App'
import { MIN_INTERPRET_AUDIO_BYTES } from './api'
import { resetKeptMicForTest } from './audio/keptMic'
import {
  AUDIO_GLOBALS, saveGlobals, setupAudioContext, setupDeferredGetUserMedia, setupMediaRecorder, setupSpeechRecognition,
} from './test/audioMocks'
import type { FakeStream } from './test/audioMocks'

// マイクはページ全体で1つ持つので、通訳の画面から言語の選択の画面に戻り、もう一度選んで録音しても、
// getUserMedia を呼ばない（docs/speech-flow.md の「マイクの持ち方」）

let restoreGlobals: () => void
let gum: ReturnType<typeof setupDeferredGetUserMedia>
let recorders: ReturnType<typeof setupMediaRecorder>
let fetchMock: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  restoreGlobals = saveGlobals(AUDIO_GLOBALS)
  resetKeptMicForTest()
  gum = setupDeferredGetUserMedia()
  recorders = setupMediaRecorder()
  setupSpeechRecognition()
  setupAudioContext()
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text: 'Hello', translatedText: 'こんにちは', ttsText: 'こんにちは', backTranslation: '(Hello)', sourceLanguage: 'en', targetLanguage: 'ja' }),
  } as unknown as Response)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreGlobals()
})

async function recordOnce() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
  const recorder = recorders.instances.at(-1)!
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob(['a'.repeat(MIN_INTERPRET_AUDIO_BYTES)]) })
    recorder.onstop?.()
  })
  await act(async () => { await Promise.resolve() })
}

describe('App kept microphone', () => {
  it('does not call getUserMedia again after going back to the language selection and selecting again', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseで話す' })) })
    let stream: FakeStream | undefined
    await act(async () => { stream = await gum.calls[0].resolve() })
    const recorder = recorders.instances[0]
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Japaneseの録音を停止' })) })
    await act(async () => {
      recorder.ondataavailable?.({ data: new Blob(['a'.repeat(MIN_INTERPRET_AUDIO_BYTES)]) })
      recorder.onstop?.()
    })
    await act(async () => { await Promise.resolve() })

    // 言語の選択の画面に戻る（通訳の画面は外れる）
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'トップ画面へ戻る' })) })
    expect(screen.queryByRole('button', { name: 'Japaneseで話す' })).not.toBeInTheDocument()
    // もう一度2つの言語を選ぶ（選んだままなので、1つ外してから選び直す）
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    await recordOnce()
    expect(gum.getUserMedia).toHaveBeenCalledTimes(1)
    expect(stream!.tracks[0].stop).not.toHaveBeenCalled()
    expect(recorders.instances).toHaveLength(2)
    expect(recorders.Ctor).toHaveBeenLastCalledWith(stream, undefined)
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]) === '/api/interpret')).toHaveLength(2)
  })
})
