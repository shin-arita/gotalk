import { vi } from 'vitest'

// 録音のライフサイクルのテスト（useAudioSession と InterpreterPage）で使う、ブラウザの音声の API の代わり。
// getUserMedia は、テストが resolve や reject をするまで終わらない。MediaRecorder の stop() は、
// 本物と同じく state を inactive にするだけで、ondataavailable と onstop はテストが起こす（autoStop で同期にもできる）

export interface FakeTrack {
  kind: string
  readyState: string
  enabled: boolean
  muted: boolean
  stop: ReturnType<typeof vi.fn>
  addEventListener: (type: string, listener: () => void) => void
}

// track が終わったこと（ほかのアプリがマイクを使った、OS が止めたなど）を起こす。readyState を ended にして、
// ended の listener を呼ぶ（本物と同じく、track.stop() では ended は起きない）
export function endTrack(track: FakeTrack) {
  track.readyState = 'ended'
  ;(track as FakeTrack & { listeners: Map<string, Set<() => void>> }).listeners.get('ended')?.forEach(l => l())
}

export interface FakeStream {
  tracks: FakeTrack[]
  getTracks: () => FakeTrack[]
  getAudioTracks: () => FakeTrack[]
}

export function makeFakeStream(tracks: Partial<FakeTrack>[] = [{}]): FakeStream {
  const made = tracks.map(t => {
    const listeners = new Map<string, Set<() => void>>()
    return {
      kind: 'audio',
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: vi.fn(),
      listeners,
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
      ...t,
    }
  })
  return {
    tracks: made,
    getTracks: () => made,
    getAudioTracks: () => made.filter(t => t.kind === 'audio'),
  }
}

export interface PendingGetUserMedia {
  resolve: (stream?: FakeStream) => Promise<FakeStream>
  reject: (error: unknown) => Promise<void>
}

// getUserMedia の呼び出しごとに、終わらせ方をテストが決める
export function setupDeferredGetUserMedia() {
  const calls: PendingGetUserMedia[] = []
  const getUserMedia = vi.fn(() => new Promise((resolve, reject) => {
    calls.push({
      resolve: async (stream = makeFakeStream()) => { resolve(stream); await Promise.resolve(); return stream },
      reject: async (error) => { reject(error); await Promise.resolve() },
    })
  }))
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true })
  return { getUserMedia, calls }
}

export interface FakeRecorder {
  state: string
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: ((e: unknown) => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

export function setupMediaRecorder(options: { autoStop?: boolean; throwOnCreate?: boolean; throwOnStart?: boolean } = {}) {
  const instances: FakeRecorder[] = []
  const Ctor = vi.fn(function () {
    if (options.throwOnCreate) throw new DOMException('not supported', 'NotSupportedError')
    const recorder: FakeRecorder = {
      state: 'inactive',
      mimeType: '',
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start: vi.fn(() => {
        if (options.throwOnStart) throw new DOMException('cannot start', 'InvalidStateError')
        recorder.state = 'recording'
      }),
      stop: vi.fn(() => {
        recorder.state = 'inactive'
        if (options.autoStop) recorder.onstop?.()
      }),
    }
    instances.push(recorder)
    return recorder
  }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean }
  Ctor.isTypeSupported = vi.fn().mockReturnValue(false)
  Object.defineProperty(globalThis, 'MediaRecorder', { value: Ctor, writable: true, configurable: true })
  return { Ctor, instances }
}

export interface FakeRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null
  onerror: ((e?: { error?: string }) => void) | null
  onend: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

export function setupSpeechRecognition(options: { throwOnCreate?: boolean; throwOnStop?: boolean } = {}) {
  const instances: FakeRecognition[] = []
  const Ctor = vi.fn(function () {
    if (options.throwOnCreate) throw new Error('unavailable')
    const recognition: FakeRecognition = {
      lang: '',
      interimResults: false,
      continuous: false,
      onresult: null,
      onerror: null,
      onend: null,
      start: vi.fn(),
      stop: vi.fn(() => { if (options.throwOnStop) throw new Error('stop failed') }),
    }
    instances.push(recognition)
    return recognition
  })
  Object.defineProperty(window, 'SpeechRecognition', { value: Ctor, writable: true, configurable: true })
  return { Ctor, instances }
}

export interface FakeAudioContext {
  state: string
  close: ReturnType<typeof vi.fn>
  createMediaStreamSource: ReturnType<typeof vi.fn>
  createAnalyser: ReturnType<typeof vi.fn>
  source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  analyser: { fftSize: number; getByteTimeDomainData: ReturnType<typeof vi.fn> }
}

export function setupAudioContext(options: { throwOnCreate?: boolean; closeRejects?: boolean } = {}) {
  const instances: FakeAudioContext[] = []
  const Ctor = vi.fn(function () {
    if (options.throwOnCreate) throw new Error('AudioContext unavailable')
    const source = { connect: vi.fn(), disconnect: vi.fn() }
    const analyser = {
      fftSize: 0,
      // 振幅 0.5 の矩形波
      getByteTimeDomainData: vi.fn((data: Uint8Array) => { data.forEach((_, i) => { data[i] = i % 2 === 0 ? 192 : 64 }) }),
    }
    const ctx: FakeAudioContext = {
      state: 'running',
      close: vi.fn(() => {
        ctx.state = 'closed'
        return options.closeRejects ? Promise.reject(new Error('close failed')) : Promise.resolve()
      }),
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      source,
      analyser,
    }
    instances.push(ctx)
    return ctx
  })
  Object.defineProperty(globalThis, 'AudioContext', { value: Ctor, writable: true, configurable: true })
  return { Ctor, instances }
}

// requestAnimationFrame を、テストが frame() を呼ぶまで進めない
export function setupAnimationFrame() {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const request = vi.fn((cb: FrameRequestCallback) => { const id = nextId++; callbacks.set(id, cb); return id })
  const cancel = vi.fn((id: number) => { callbacks.delete(id) })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: request, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: cancel, writable: true, configurable: true })
  const frame = (time = 16) => {
    const pending = [...callbacks.entries()]
    callbacks.clear()
    pending.forEach(([, cb]) => cb(time))
  }
  return { request, cancel, frame, pendingCount: () => callbacks.size }
}

// テストで置き換える global を、テスト前の状態（property がない場合も含む）に戻す
type SavedProperty = { target: object; key: string; descriptor: PropertyDescriptor | undefined }

export function saveGlobals(entries: [object, string][]): () => void {
  const saved: SavedProperty[] = entries.map(([target, key]) => ({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }))
  return () => {
    for (const { target, key, descriptor } of saved) {
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else delete (target as Record<string, unknown>)[key]
    }
  }
}

export const AUDIO_GLOBALS: [object, string][] = [
  [globalThis.navigator, 'mediaDevices'],
  [globalThis, 'MediaRecorder'],
  [window, 'SpeechRecognition'],
  [window, 'webkitSpeechRecognition'],
  [globalThis, 'AudioContext'],
  [globalThis, 'requestAnimationFrame'],
  [globalThis, 'cancelAnimationFrame'],
  [globalThis, 'Audio'],
  [globalThis.URL, 'createObjectURL'],
  [globalThis.URL, 'revokeObjectURL'],
  [document, 'visibilityState'],
]

export function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

export function firePageTransition(type: 'pagehide' | 'pageshow', persisted: boolean) {
  const event = new Event(type)
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}
