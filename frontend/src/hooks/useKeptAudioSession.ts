import { useLayoutEffect, useState } from 'react'
import * as keptMic from '../audio/keptMic'

// 通訳の画面の録音のセッション。マイクを閉じない（docs/speech-flow.md）。マイク（stream）は keptMic が
// ページ全体で1つ持ち、このセッションは track の stop() を呼ばず、track に listener も付けない。
// MediaRecorder、音声認識、音量の取得（AudioContext と analyser、requestAnimationFrame）は録音ごとに作って片付ける。
// 画面の状態（InterpreterStatus）は持たない。持つのは、録音の資源とセッションの番号だけで、
// 「録音が成立した」「録音の最後のデータがそろった」「失敗した」などを callback で画面に知らせる

// 中断の理由。利用者の停止（user）とは別に、セッションを先に無効にして、録音のデータを送らずに片付ける
export type AudioSessionAbortReason = 'hidden' | 'pagehide' | 'back' | 'unmount' | 'error' | 'cancel'
export type AudioSessionStopReason = 'user' | AudioSessionAbortReason

// 録音の成立までの失敗。getUserMedia の失敗は microphone_denied、getUserMedia の成功の後の失敗
// （track がない、live でない、MediaRecorder の作成や start() の例外）は recording_start_failed
export type AudioSessionStartFailure = 'microphone_denied' | 'recording_start_failed'

export interface AudioSessionCallbacks {
  // 録音の成立（マイク ON）
  onRecordingStarted: () => void
  // 録音の成立までの失敗。資源は片付けた後に呼ぶ。reason はエラーの name（ログ用）
  onStartFailed: (failure: AudioSessionStartFailure, reason: string) => void
  // 音声認識の途中の文字
  onTranscript: (transcript: string) => void
  // 音量（0 から 1）と、音量の取得を始めてからの時間（ミリ秒）。波紋の表示に使う
  onLevel: (amplitude: number, elapsedMs: number) => void
  // 利用者の停止で、録音の最後のデータがそろい、マイク OFF が成立した後に呼ぶ
  onRecordingStopped: (blob: Blob) => void
  // 録音の成立の後の失敗（録音の途中の MediaRecorder の onerror、利用者の停止での stop() の例外など）。
  // 中断の片付け（理由 error）の後に呼ぶ。録音のデータは送らない
  onRecorderError: () => void
  // 画面の状態が recording か（音声認識の onend で始め直してよいかの判断に使う）
  isRecordingStatus: () => boolean
}

export interface AudioDiagnosticEvent {
  type: string
  at: number
  sessionId: number | null
}

// 録音ごとの診断の情報。録音した音声と会話の本文は残さない（音声認識は、結果があったかと文字数だけ）
export interface AudioSessionDiagnostics {
  id: number
  stopReason: AudioSessionStopReason | null
  getUserMedia: { startedAt: number | null; succeededAt: number | null; errorName: string | null }
  tracks: { readyState: string; enabled: boolean; muted: boolean }[]
  recorder: {
    state: string | null
    mimeType: string | null
    startedAt: number | null
    stoppedAt: number | null
    durationMs: number | null
    // 利用者の停止で stop() を呼んだ時刻（MediaRecorder がすでに inactive のときは、止める指示を記録した時刻）
    stopRequestedAt: number | null
    // stopRequestedAt から onstop が届くまでの時間（ミリ秒）。見張りのタイマーで片付けた後に届いた場合も残す
    stopLatencyMs: number | null
    // 見張りのタイマーで片付けたか。片付けたときは、それまでに待った時間を stopWaitedMs に残す
    stopTimedOut: boolean
    stopWaitedMs: number | null
    bytes: number
    errorName: string | null
  }
  audioContext: { state: string | null }
  level: { rms: number; rmsMax: number; peak: number; samples: number }
  recognition: { hadResult: boolean; chars: number }
}

export interface AudioDiagnostics {
  sessions: AudioSessionDiagnostics[]
  events: AudioDiagnosticEvent[]
}

export interface AudioSession {
  start: (speechCode: string) => Promise<void>
  stop: () => void
  abort: (reason: AudioSessionAbortReason) => Promise<void>
  hasActiveSession: () => boolean
  logEvent: (type: string) => void
  getDiagnostics: () => AudioDiagnostics
  // 最新の callback に入れ替える（画面の再描画のたびに呼ぶ）
  setCallbacks: (callbacks: AudioSessionCallbacks) => void
}

// 利用者の停止で、MediaRecorder の onstop を待つ最長の時間（ミリ秒）。届かないままだと stopping のままマイクが
// 開き続けるので、この時間で見切りを付けて録音の失敗として片付ける。
// 実機で確かめていない仮の値。短すぎると正常な長い録音（古い端末の audio/mp4 で上限に近い録音など）を捨て、
// 長すぎるとブラウザの不具合で onstop が届かないときに track が長く開いているだけなので、損失の小さい長めの値にしている。
// PR 2 の診断の表示で stop() から onstop までの時間（AudioSessionDiagnostics の recorder.stopLatencyMs）を測り、
// 実測の値に余裕を足した値に見直す
export const RECORDER_STOP_TIMEOUT_MS = 10_000

interface SpeechRecognitionEvent {
  readonly results: { readonly length: number; readonly [i: number]: { readonly [j: number]: { readonly transcript: string } } }
}

interface SpeechRecognitionErrorEvent {
  readonly error?: string
}

interface SpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event?: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : typeof e
}

// 診断の情報をメモリの上に残す数
const MAX_DIAGNOSTIC_SESSIONS = 10
const MAX_DIAGNOSTIC_EVENTS = 200

// 録音ごとの診断の情報。getUserMedia の項目に、この録音で keptMic.acquire() を呼んだか（acquired）、
// 持っているマイクを使い回したか（reused）を足す
export interface KeptAudioSessionDiagnostics extends AudioSessionDiagnostics {
  getUserMedia: AudioSessionDiagnostics['getUserMedia'] & { acquired: boolean; reused: boolean }
}

// 診断の情報。keptMic の診断（getUserMedia を呼んだ回数と、track の ended の記録）を足す（「コピー」の JSON に入る）
export interface KeptAudioDiagnostics extends AudioDiagnostics {
  keptMic: { getUserMediaCalls: number; endedEvents: keptMic.KeptMicEndedEvent[] }
}

// 録音の資源のまとまり。stream は keptMic が持つもので、このセッションは閉じない
interface Session {
  id: number
  stream: MediaStream | null
  recorder: MediaRecorder | null
  recognition: SpeechRecognition | null
  audioContext: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  analyser: AnalyserNode | null
  rafId: number | null
  levelMeterClosed: Promise<void> | null
  stopReason: AudioSessionStopReason | null
  stopRequested: boolean
  recorderStopped: boolean
  stopTimer: ReturnType<typeof setTimeout> | null
  chunks: Blob[]
  mimeType: string
  diag: KeptAudioSessionDiagnostics
}

function newDiagnostics(id: number): KeptAudioSessionDiagnostics {
  return {
    id,
    stopReason: null,
    getUserMedia: { startedAt: null, succeededAt: null, errorName: null, acquired: false, reused: false },
    tracks: [],
    recorder: {
      state: null,
      mimeType: null,
      startedAt: null,
      stoppedAt: null,
      durationMs: null,
      stopRequestedAt: null,
      stopLatencyMs: null,
      stopTimedOut: false,
      stopWaitedMs: null,
      bytes: 0,
      errorName: null,
    },
    audioContext: { state: null },
    level: { rms: 0, rmsMax: 0, peak: 0, samples: 0 },
    recognition: { hadResult: false, chars: 0 },
  }
}

// マイクを閉じない録音のセッションを作る。callback は setCallbacks で最新のものに入れ替え、呼ぶたびに最新のものを使う
export function createKeptAudioSession(initialCallbacks: AudioSessionCallbacks): AudioSession {
  let latestCallbacks = initialCallbacks
  const callbacks = () => latestCallbacks
  let nextId = 0
  // 今有効なセッションの番号（なしは null）と、その資源のまとまり
  let activeId: number | null = null
  let current: Session | null = null
  const diagnostics: AudioDiagnostics = { sessions: [], events: [] }

  const now = () => Date.now()
  const isActive = (id: number) => activeId === id

  const logEvent = (type: string, sessionId: number | null = activeId ?? diagnostics.sessions.at(-1)?.id ?? null) => {
    diagnostics.events.push({ type, at: now(), sessionId })
    if (diagnostics.events.length > MAX_DIAGNOSTIC_EVENTS) diagnostics.events.shift()
  }

  const stopRecognition = (s: Session) => {
    const recognition = s.recognition
    s.recognition = null
    if (!recognition) return
    try { recognition.stop() } catch { /* 止める処理の例外は捨てる */ }
  }

  const stopLevelMeter = (s: Session) => {
    if (s.rafId !== null) {
      cancelAnimationFrame(s.rafId)
      s.rafId = null
    }
  }

  const clearStopTimer = (s: Session) => {
    if (s.stopTimer !== null) {
      clearTimeout(s.stopTimer)
      s.stopTimer = null
    }
  }

  // 音量の取得の資源（MediaStreamAudioSourceNode と AudioContext）を片付ける（冪等）。source node を disconnect() し、
  // AudioContext の close() を始める。2回目以降は、1回目に始めた close() の完了の Promise を返す。
  // MediaRecorder の stop() より前に呼ぶ
  const releaseLevelMeter = (s: Session): Promise<void> => {
    if (s.levelMeterClosed) return s.levelMeterClosed
    if (s.sourceNode) {
      try { s.sourceNode.disconnect() } catch { /* 捨てる */ }
    }
    s.sourceNode = null
    s.analyser = null
    const audioContext = s.audioContext
    s.audioContext = null
    let closed: Promise<void>
    if (!audioContext || audioContext.state === 'closed') {
      closed = Promise.resolve()
    } else {
      try {
        closed = audioContext.close()
          .catch(() => { /* close() の拒否は捨てる */ })
          .finally(() => { s.diag.audioContext.state = audioContext.state })
      } catch {
        closed = Promise.resolve()
      }
    }
    s.levelMeterClosed = closed
    return closed
  }

  // 録音の資源を止めて参照を捨てる（冪等）。AudioContext の close() が終わるまでの Promise を返す。
  // track の stop() は呼ばず、stream の参照も捨てない（マイクは keptMic が持ち、閉じない）
  const release = (s: Session): Promise<void> => {
    s.stopRequested = true
    clearStopTimer(s)
    stopRecognition(s)
    stopLevelMeter(s)
    const closed = releaseLevelMeter(s)
    const recorder = s.recorder
    s.recorder = null
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch { /* 止める処理の例外は捨てる */ }
    }
    if (recorder) s.diag.recorder.state = recorder.state
    return closed
  }

  // 今有効なセッションが s なら無効にしてから、s の資源を片付ける
  const teardown = (s: Session, reason: AudioSessionStopReason): Promise<void> => {
    if (current === s) {
      current = null
      activeId = null
    }
    s.diag.stopReason = reason
    s.stopReason = reason
    return release(s)
  }

  // 録音の成立の後の失敗。中断の片付け（理由 error）をしてから、画面に知らせる。録音のデータは送らない
  const failRecording = (s: Session, type: string) => {
    logEvent(type, s.id)
    void teardown(s, 'error')
    callbacks().onRecorderError()
  }

  // 利用者の停止で、最後のデータがそろった後の処理。録音の資源を片付けてから、画面に知らせる
  const finishUserStop = (s: Session) => {
    const blob = new Blob(s.chunks, { type: s.mimeType || 'audio/webm' })
    s.chunks = []
    s.diag.recorder.stoppedAt = now()
    if (s.diag.recorder.startedAt !== null) s.diag.recorder.durationMs = s.diag.recorder.stoppedAt - s.diag.recorder.startedAt
    void teardown(s, 'user')
    logEvent('recording_stopped', s.id)
    callbacks().onRecordingStopped(blob)
  }

  // 音量の取得（録音ごとに AudioContext を作る）
  const startLevelMeter = (s: Session, stream: MediaStream) => {
    // 止める指示の後や、音量の取得の片付けの後は始めない
    if (s.stopRequested || s.levelMeterClosed) return
    try {
      const audioContext = new AudioContext()
      s.audioContext = audioContext
      s.diag.audioContext.state = audioContext.state
      const source = audioContext.createMediaStreamSource(stream)
      s.sourceNode = source
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      s.analyser = analyser

      const timeData = new Uint8Array(analyser.fftSize)
      let startTime: number | null = null
      const tick = (time: number) => {
        s.rafId = null
        if (!isActive(s.id) || s.stopRequested) return
        if (startTime === null) startTime = time
        analyser.getByteTimeDomainData(timeData)
        let sum = 0
        let peak = 0
        for (let j = 0; j < timeData.length; j++) {
          const v = (timeData[j] - 128) / 128
          sum += v * v
          peak = Math.max(peak, Math.abs(v))
        }
        const rms = Math.sqrt(sum / timeData.length)
        const level = s.diag.level
        level.rms = rms
        level.rmsMax = Math.max(level.rmsMax, rms)
        level.peak = Math.max(level.peak, peak)
        level.samples += 1
        s.diag.audioContext.state = audioContext.state
        callbacks().onLevel(Math.min(1, rms * 8), time - startTime)
        s.rafId = requestAnimationFrame(tick)
      }
      s.rafId = requestAnimationFrame(tick)
    } catch (e) {
      // 補助の機能の失敗。録音は続ける（波紋の表示と診断の値が出ないだけ）
      logEvent(`level_meter_failed:${errorName(e)}`, s.id)
    }
  }

  // 音声認識（録音ごとに作る。onend での始め直しの条件は、下の onend のとおり）
  const startRecognition = (s: Session, speechCode: string) => {
    if (s.stopRequested) return
    const RecognitionCtor = getSpeechRecognitionCtor()
    if (!RecognitionCtor) {
      logEvent('recognition_unavailable', s.id)
      return
    }
    try {
      const recognition = new RecognitionCtor()
      recognition.lang = speechCode
      recognition.interimResults = true
      recognition.continuous = true
      recognition.onresult = (event) => {
        if (!isActive(s.id)) return
        let transcript = ''
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript
        }
        s.diag.recognition.hadResult = true
        s.diag.recognition.chars = transcript.length
        callbacks().onTranscript(transcript)
      }
      recognition.onerror = (event) => {
        if (!isActive(s.id)) return
        logEvent(`recognition_error:${event?.error ?? 'unknown'}`, s.id)
      }
      recognition.onend = () => {
        // 始め直すのは、自分のセッションが有効で、画面が recording で、止める指示が出ていないときだけ
        if (!isActive(s.id) || s.stopRequested || s.recognition !== recognition || !callbacks().isRecordingStatus()) return
        try { recognition.start() } catch { /* 始め直しの失敗は捨てる */ }
      }
      s.recognition = recognition
      recognition.start()
    } catch (e) {
      // 補助の機能の失敗。録音は続け、Backend の文字起こしだけで結果を出す
      s.recognition = null
      logEvent(`recognition_failed:${errorName(e)}`, s.id)
    }
  }

  const start = async (speechCode: string): Promise<void> => {
    if (current) {
      // 画面が二重に始めないようにしているので、ここには来ない。来た場合は前のセッションを片付ける
      logEvent('unexpected_active_session_on_start')
      void teardown(current, 'error')
    }
    nextId += 1
    const id = nextId
    const s: Session = {
      id,
      stream: null,
      recorder: null,
      recognition: null,
      audioContext: null,
      sourceNode: null,
      analyser: null,
      rafId: null,
      levelMeterClosed: null,
      stopReason: null,
      stopRequested: false,
      recorderStopped: false,
      stopTimer: null,
      chunks: [],
      mimeType: '',
      diag: newDiagnostics(id),
    }
    activeId = id
    current = s
    diagnostics.sessions.push(s.diag)
    if (diagnostics.sessions.length > MAX_DIAGNOSTIC_SESSIONS) diagnostics.sessions.shift()

    // 持っているマイクが使えれば、await を挟まずに録音を始める（利用者の操作の中で同期的に録音を始める。
    // 切り分けの実験（マイクを開いたまま使い回す方式）で、実機で確かめた形）。使えなければ keptMic で取得する
    let stream = keptMic.peekLive()
    if (stream) {
      s.diag.getUserMedia.reused = true
      logEvent('microphone_reused', id)
    } else {
      s.diag.getUserMedia.acquired = true
      s.diag.getUserMedia.startedAt = now()
      logEvent('get_user_media_start', id)
      try {
        stream = await keptMic.acquire()
      } catch (e) {
        const name = errorName(e)
        s.diag.getUserMedia.errorName = name
        logEvent(`get_user_media_failed:${name}`, id)
        if (!isActive(id)) return
        void teardown(s, 'error')
        callbacks().onStartFailed('microphone_denied', name)
        return
      }
      if (!isActive(id)) {
        // 待っている間に中断された。取得した stream は keptMic が持つので閉じずに、次の録音で使い回す
        logEvent('stale_get_user_media_kept', id)
        return
      }
      s.diag.getUserMedia.succeededAt = now()
      logEvent('get_user_media_succeeded', id)
    }
    s.stream = stream

    try {
      const tracks = stream.getAudioTracks()
      s.diag.tracks = tracks.map(t => ({ readyState: t.readyState, enabled: t.enabled, muted: t.muted }))
      if (tracks.length === 0) throw new DOMException('no audio track', 'NoAudioTrackError')
      if (tracks.some(t => t.readyState !== 'live')) throw new DOMException('audio track is not live', 'TrackNotLiveError')

      s.mimeType = getSupportedMimeType()
      const recorder = new MediaRecorder(stream, s.mimeType ? { mimeType: s.mimeType } : undefined)
      s.recorder = recorder
      recorder.ondataavailable = (e) => {
        // 無効なセッションのデータは捨てる
        if (!isActive(id)) return
        if (e.data.size > 0) {
          s.chunks.push(e.data)
          s.diag.recorder.bytes += e.data.size
        }
      }
      recorder.onstop = () => {
        s.recorderStopped = true
        // 利用者の停止から onstop までの時間を残す（見張りのタイマーで片付けた後に届いた場合も）
        const { stopRequestedAt } = s.diag.recorder
        if (stopRequestedAt !== null) s.diag.recorder.stopLatencyMs = now() - stopRequestedAt
        // 中断のときは、セッションを先に無効にしているので、ここでは何もしない
        if (!isActive(id)) return
        if (s.stopReason === 'user') {
          finishUserStop(s)
          return
        }
        // 利用者の停止の前に、MediaRecorder が自分で止まった（track が終わったときなど）。録音の失敗として片付け、送らない
        if (!s.stopRequested) failRecording(s, 'recorder_stopped_unexpectedly')
      }
      recorder.onerror = (e) => {
        if (!isActive(id)) return
        const name = errorName((e as Event & { error?: unknown }).error ?? e)
        s.diag.recorder.errorName = name
        failRecording(s, `recorder_error:${name}`)
      }
      recorder.start()
      // track には listener を付けない（ended の見張りは keptMic が持つ）。録音の途中で track が終わったときの録音の
      // 失敗の扱いは、その後に MediaRecorder が自分で止まったとき（onstop）に行う
      s.diag.recorder.state = recorder.state
      s.diag.recorder.mimeType = recorder.mimeType || s.mimeType || null
      s.diag.recorder.startedAt = now()
    } catch (e) {
      const name = errorName(e)
      s.diag.recorder.errorName = name
      logEvent(`recording_start_failed:${name}`, id)
      // 片付けても track は止めない
      void teardown(s, 'error')
      callbacks().onStartFailed('recording_start_failed', name)
      return
    }

    logEvent('recording_started', id)
    callbacks().onRecordingStarted()
    if (!isActive(id)) return
    // 補助の機能は、録音の成立の後に開始を試みる。失敗しても録音は続ける
    startLevelMeter(s, stream)
    startRecognition(s, speechCode)
  }

  // 利用者の停止。止める指示を先に記録してから、音声認識と音量の取得を止め、MediaRecorder の onstop を待つ
  // （片付けの順番は release と同じ）。track の stop() は呼ばない
  const stop = () => {
    const s = current
    if (!s || s.stopRequested || !s.recorder) return
    s.stopRequested = true
    s.stopReason = 'user'
    s.diag.stopReason = 'user'
    logEvent('user_stop', s.id)
    stopRecognition(s)
    stopLevelMeter(s)
    releaseLevelMeter(s)
    const recorder = s.recorder
    const stopRequestedAt = now()
    s.diag.recorder.stopRequestedAt = stopRequestedAt
    if (recorder.state === 'inactive') {
      // MediaRecorder が自分で inactive になり、dataavailable と stop のイベントがまだ届いていない。onstop を待つ
      logEvent('recorder_already_inactive', s.id)
    } else {
      try {
        recorder.stop()
      } catch (e) {
        const name = errorName(e)
        s.diag.recorder.errorName = name
        failRecording(s, `recorder_stop_failed:${name}`)
        return
      }
    }
    // onstop が同期で届いて終わっていれば、見張りは要らない
    if (!isActive(s.id)) return
    s.stopTimer = setTimeout(() => {
      s.stopTimer = null
      // 古いセッションのタイマーは何もしない（片付けで止めているが、念のため確かめる）
      if (!isActive(s.id)) return
      s.diag.recorder.stopTimedOut = true
      s.diag.recorder.stopWaitedMs = now() - stopRequestedAt
      failRecording(s, 'recorder_stop_timeout')
    }, RECORDER_STOP_TIMEOUT_MS)
  }

  // 中断の片付け。どの理由でも、今有効なセッションを先に無効にしてから、録音の資源だけを片付ける（マイクは閉じない）。
  // 録音のデータは送らない
  const abort = (reason: AudioSessionAbortReason): Promise<void> => {
    const s = current
    current = null
    activeId = null
    if (!s) return Promise.resolve()
    logEvent(`abort:${reason}`, s.id)
    return teardown(s, reason)
  }

  return {
    start,
    stop,
    abort,
    hasActiveSession: () => current !== null,
    logEvent: (type: string) => logEvent(type),
    getDiagnostics: (): KeptAudioDiagnostics => ({
      sessions: [...diagnostics.sessions],
      events: [...diagnostics.events],
      keptMic: { getUserMediaCalls: keptMic.getUserMediaCalls(), endedEvents: keptMic.endedEvents() },
    }),
    setCallbacks: (next: AudioSessionCallbacks) => { latestCallbacks = next },
  }
}

// マイクを閉じないセッションを使う hook。返す AudioSession は、画面が外れるまで同じもの
export function useKeptAudioSession(callbacks: AudioSessionCallbacks): AudioSession {
  const [session] = useState(() => createKeptAudioSession(callbacks))
  useLayoutEffect(() => {
    session.setCallbacks(callbacks)
  })
  return session
}
