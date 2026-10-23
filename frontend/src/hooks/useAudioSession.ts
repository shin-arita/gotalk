import { useLayoutEffect, useState } from 'react'
import { DEFAULT_EXPERIMENT_CONFIG } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import {
  addExperimentSession, addPageEvent, cloneExperimentDiagnostics, newExperimentDiagnostics, newExperimentSessionTrace, pushBounded,
} from './experimentTrace'
import type { ExperimentDiagnostics, ExperimentSessionTrace } from './experimentTrace'

// 通訳の画面の録音のセッション（docs/speech-flow.md）。getUserMedia、track の stop()、MediaRecorder、音声認識、
// 音量の取得（AudioContext と analyser、requestAnimationFrame）を、ここにまとめる。
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
  // 切り分けの実験の診断（URL に exp があるときだけ。docs/testing.md）
  experiment?: ExperimentDiagnostics
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
  // 切り分けの実験（trace）で、ページの出来事（visibilitychange、pagehide、pageshow）を記録する。trace でないときは何もしない
  recordPageEvent: (type: string, persisted?: boolean) => void
  // 切り分けの実験（nolifecycle と trace）で、記録のためだけの listener を付けたことを診断に残す
  markTraceListenerOnly: () => void
}

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
  // 切り分けの実験（trace）でだけ付ける
  onstart?: (() => void) | null
  onaudiostart?: (() => void) | null
  onaudioend?: (() => void) | null
  start(): void
  stop(): void
  // 切り分けの実験（recogabort）でだけ呼ぶ
  abort(): void
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

// 利用者の停止で、MediaRecorder の onstop を待つ最長の時間（ミリ秒）。届かないままだと stopping のままマイクが
// 開き続けるので、この時間で見切りを付けて録音の失敗として片付ける。
// 実機で確かめていない仮の値。短すぎると正常な長い録音（古い端末の audio/mp4 で上限に近い録音など）を捨て、
// 長すぎるとブラウザの不具合で onstop が届かないときに track が長く開いているだけなので、損失の小さい長めの値にしている。
// PR 2 の診断の表示で stop() から onstop までの時間（AudioSessionDiagnostics の recorder.stopLatencyMs）を測り、
// 実測の値に余裕を足した値に見直す
export const RECORDER_STOP_TIMEOUT_MS = 10_000

// 切り分けの実験（recogfirst）で、利用者の停止のときに音声認識の end を待つ最長の時間（ミリ秒）。
// 届かないときは見切って MediaRecorder の stop() を呼ぶ（見張りのタイマー RECORDER_STOP_TIMEOUT_MS とは別）
export const RECOGNITION_END_TIMEOUT_MS = 1_500
// 切り分けの実験（recogfirst と recogdelay）で、end が届いた後、MediaRecorder の stop() を呼ぶまでにさらに待つ時間（ミリ秒）
export const RECOGNITION_END_DELAY_MS = 500

// 切り分けの実験（recogfirst）の、音声認識の end の待ち。音声認識の部品とセッションの番号の組に結び付ける。
// waiting（end を待っている）→ delaying（recogdelay の 500 ミリ秒）→ done（MediaRecorder の stop() に進んだ）、
// または timedout（1.5 秒で見切った）、cancelled（待っている間に中断した）。done、timedout、cancelled からは戻らない
interface RecognitionEndWait {
  recognition: SpeechRecognition
  sessionId: number
  state: 'waiting' | 'delaying' | 'done' | 'timedout' | 'cancelled'
  // 1.5 秒の見切りのタイマー（waiting のとき）か、500 ミリ秒のタイマー（delaying のとき）
  timer: ReturnType<typeof setTimeout> | null
  // 待ちの後の処理（MediaRecorder の stop() に進む）。セッションが有効かは、この中で確かめる
  proceed: () => void
}

// 診断の情報をメモリの上に残す数
const MAX_DIAGNOSTIC_SESSIONS = 10
const MAX_DIAGNOSTIC_EVENTS = 200

// 録音の資源のまとまり。片付けは、このまとまりに対して行う
interface Session {
  id: number
  stream: MediaStream | null
  recorder: MediaRecorder | null
  recognition: SpeechRecognition | null
  audioContext: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  analyser: AnalyserNode | null
  rafId: number | null
  // 音量の取得の資源の片付け（releaseLevelMeter）で始めた AudioContext の close() の完了。片付けの前は null
  levelMeterClosed: Promise<void> | null
  stopReason: AudioSessionStopReason | null
  stopRequested: boolean
  // MediaRecorder の onstop が届いたか（止める理由によらず記録する）
  recorderStopped: boolean
  // 利用者の停止で onstop を待つ見張りのタイマー
  stopTimer: ReturnType<typeof setTimeout> | null
  // 切り分けの実験（recogfirst）の、音声認識の end の待ち。スイッチがないときは常に null
  recognitionEndWait: RecognitionEndWait | null
  chunks: Blob[]
  mimeType: string
  diag: AudioSessionDiagnostics
  // 切り分けの実験の記録（URL に exp がないときは null で、何も記録しない）
  exp: ExperimentSessionTrace | null
}

function newDiagnostics(id: number): AudioSessionDiagnostics {
  return {
    id,
    stopReason: null,
    getUserMedia: { startedAt: null, succeededAt: null, errorName: null },
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

// 録音のセッションを作る。callback は setCallbacks で最新のものに入れ替え、呼ぶたびに最新のものを使う
// （React の closure の古い値を使わないため）。
// config は切り分けの実験のスイッチ（docs/testing.md）。省略したときは、すべてのスイッチが false で、今の本番と同じ動き。
// スイッチの分岐は、今のコードをそのまま条件の中に置く形にしている（スイッチがないときのブラウザの API の呼び出しの
// 順番と回数を変えないため）
export function createAudioSession(
  initialCallbacks: AudioSessionCallbacks,
  config: ExperimentConfig = DEFAULT_EXPERIMENT_CONFIG,
): AudioSession {
  let latestCallbacks = initialCallbacks
  const callbacks = () => latestCallbacks
  let nextId = 0
  // 今有効なセッションの番号（なしは null）と、その資源のまとまり
  let activeId: number | null = null
  let current: Session | null = null
  const diagnostics: AudioDiagnostics = { sessions: [], events: [] }
  // 切り分けの実験の診断。URL に exp がないときは作らない（performance.now() の記録もしない）
  const expDiag: ExperimentDiagnostics | null = config.enabled ? newExperimentDiagnostics(config) : null
  const perfNow = () => performance.now()
  // 実験の recogonce：画面で1つだけ作る音声認識の部品と、その前の実行が終わっていないか（start() の成功の後に true、
  // どのセッションの handler でも onend の最初に false）。end は1回の実行の最後の出来事なので、true の間に次のセッションの
  // handler を付け替えると、前の実行の遅れた出来事が次のセッションのものとして配られる。そのため true の間は次の録音で
  // 音声認識を始めない
  let onceRecognition: SpeechRecognition | null = null
  let onceRecognitionRunning = false
  const recordOnce = (type: string, sessionId: number) => {
    if (expDiag?.recognitionOnce) pushBounded(expDiag.recognitionOnce.events, { type, at: perfNow(), boundSessionId: sessionId, activeSessionId: activeId })
  }

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
    // 実験の recogearly：録音の成立（MediaRecorder の start() の成功）の前に止めた時刻を残す
    if (s.exp?.recogEarly && s.diag.recorder.startedAt === null) s.exp.recogEarly.stoppedBeforeRecordingAt = perfNow()
    // 実験の recogabort：stop() の代わりに abort() を呼ぶ（利用者の停止と、中断の片付けの両方）
    if (config.recogAbort) {
      if (s.exp) pushBounded(s.exp.recognition.events, { type: 'abort_call', at: perfNow() })
      try { recognition.abort() } catch { /* 止める処理の例外は捨てる */ }
      return
    }
    if (s.exp) pushBounded(s.exp.recognition.events, { type: 'stop_call', at: perfNow() })
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

  // releaseLevelMeter の1回目の中身。source node を disconnect() し、AudioContext の close() を始める
  const closeLevelMeter = (s: Session): Promise<void> => {
    if (s.sourceNode) {
      // 実験の nodisconnect：disconnect() を呼ばず、close() だけにする（PR #26 の前と同じ）
      if (!config.noDisconnect) {
        try { s.sourceNode.disconnect() } catch { /* 捨てる */ }
        if (s.exp) s.exp.audioContext.disconnectedAt = perfNow()
      } else if (s.exp) {
        s.exp.audioContext.disconnectSkipped = true
      }
    }
    s.sourceNode = null
    s.analyser = null
    const audioContext = s.audioContext
    s.audioContext = null
    if (!audioContext || audioContext.state === 'closed') return Promise.resolve()
    try {
      if (s.exp) s.exp.audioContext.closeCalledAt = perfNow()
      return audioContext.close()
        .catch(() => { /* close() の拒否は捨てる */ })
        .finally(() => {
          s.diag.audioContext.state = audioContext.state
          if (s.exp) s.exp.audioContext.closeResolvedAt = perfNow()
        })
    } catch {
      return Promise.resolve()
    }
  }

  // 音量の取得の資源（MediaStreamAudioSourceNode と AudioContext）を片付ける（冪等）。
  // close() が終わるまでの Promise を返す。2回目以降は、1回目に始めた close() の完了の Promise を返す
  // （利用者の停止で先に close() を始めた後の abort でも、close() の完了まで待つため）。
  // MediaRecorder の stop() と track の stop() より前に呼ぶこと。iPhone の Chrome（WebKit）では、AudioContext に
  // MediaStreamAudioSourceNode でつながったままの track を stop() すると、次の getUserMedia で開いたマイクから
  // 音が来なくなる（2回目からの録音が空になる）という仮説による（実機で確かめていない）。
  // PR #26 の前（07f06f0）は、AudioContext を先に close() してから MediaRecorder と track を止めており、
  // 2回目からも録音できていたので、その順番に戻している
  const releaseLevelMeter = (s: Session): Promise<void> => {
    if (s.levelMeterClosed) return s.levelMeterClosed
    s.levelMeterClosed = closeLevelMeter(s)
    return s.levelMeterClosed
  }

  // 資源を止めて参照を捨てる（冪等）。AudioContext の close() が終わるまでの Promise を返す。
  // 音量の取得の資源を先に片付けてから、MediaRecorder と track を止める（順番の理由は releaseLevelMeter）
  const release = (s: Session): Promise<void> => {
    s.stopRequested = true
    clearStopTimer(s)
    // 実験の recogfirst：end の待ちを無効にし、タイマーを取り消す（待ちの後に MediaRecorder の stop() を呼ばない）
    if (config.recogFirst) cancelRecognitionEndWait(s)
    stopRecognition(s)
    stopLevelMeter(s)
    const closed = releaseLevelMeter(s)
    const recorder = s.recorder
    s.recorder = null
    if (recorder && recorder.state !== 'inactive') {
      if (s.exp) s.exp.recorder.stopCalls.push({ at: perfNow(), by: 'cleanup' })
      try { recorder.stop() } catch { /* 止める処理の例外は捨てる */ }
    }
    if (recorder) s.diag.recorder.state = recorder.state
    const stream = s.stream
    s.stream = null
    // ended の track に stop() を呼んでも害はない
    stream?.getTracks().forEach(t => t.stop())
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

  // 利用者の停止で、最後のデータがそろった後の処理。マイク OFF を成立させてから、画面に知らせる
  const finishUserStop = (s: Session) => {
    const blob = new Blob(s.chunks, { type: s.mimeType || 'audio/webm' })
    if (s.exp) s.exp.recorder.blobSize = blob.size
    s.chunks = []
    s.diag.recorder.stoppedAt = now()
    if (s.diag.recorder.startedAt !== null) s.diag.recorder.durationMs = s.diag.recorder.stoppedAt - s.diag.recorder.startedAt
    void teardown(s, 'user')
    logEvent('recording_stopped', s.id)
    callbacks().onRecordingStopped(blob)
  }

  const startLevelMeter = (s: Session, stream: MediaStream) => {
    // 止める指示の後や、音量の取得の片付け（releaseLevelMeter）の後は始めない。片付けは2回目以降、1回目の
    // Promise を返すだけなので、その後に作った AudioContext は閉じられず、マイクの track につながったまま残るため。
    // 今の経路では来ない（将来の変更への守り）。onRecordingStarted の中の中断は、start がその後にセッションが有効かを
    // 確かめて止めるが、利用者の停止はセッションを有効のまま残すので、その確かめでは止まらない。画面は、利用者の停止を
    // 国旗のタップからだけ呼ぶので、onRecordingStarted の中で呼ばれることはない
    if (s.stopRequested || s.levelMeterClosed) return
    try {
      const audioContext = new AudioContext()
      if (s.exp) s.exp.audioContext.createdAt = perfNow()
      s.audioContext = audioContext
      s.diag.audioContext.state = audioContext.state
      const source = audioContext.createMediaStreamSource(stream)
      s.sourceNode = source
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      if (s.exp) s.exp.audioContext.sourceConnectedAt = perfNow()
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
        if (s.exp) {
          if (s.exp.level.firstSampleAt === null) s.exp.level.firstSampleAt = time
          if (rms > 0 && s.exp.level.firstNonZeroAt === null) s.exp.level.firstNonZeroAt = time
        }
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

  const startRecognition = (s: Session, speechCode: string) => {
    // 止める指示の後は始めない（音量の取得の守りとそろえ、止める指示の後に新しい音声の部品を始めない）。
    // 始めても onstop の後の片付けで止まるので残らないが、MediaRecorder の stop() の直後に音声認識を始めてすぐ止める
    // 並びが、iPhone の Chrome（WebKit）の音声のセッションに影響しないとは言い切れないため（今回の不具合が、音声の
    // 部品の始まりと終わりの順番による仮説のため）。
    // 今の経路では来ない（将来の変更への守り）。理由は startLevelMeter の守りと同じで、画面は利用者の停止を
    // 国旗のタップからだけ呼ぶので、onRecordingStarted の中で呼ばれることはない
    if (s.stopRequested) return
    const RecognitionCtor = getSpeechRecognitionCtor()
    if (!RecognitionCtor) {
      logEvent('recognition_unavailable', s.id)
      return
    }
    try {
      // 実験の recogonce：部品は画面で1つだけ作り（最初の録音のときに作る）、録音ごとに start() と stop() を繰り返す。
      // handler は start() のたびに、そのときのセッション s に結び付けたものに付け替える（下の handler は s を見て、
      // s が今有効なセッションでないときは、録音の処理に作用させない）
      let recognition: SpeechRecognition
      if (config.recogOnce) {
        // 前の実行の end が届いていないときは、handler の付け替えも start() もせず、この録音は音声認識なしで続ける
        // （s.recognition は空のまま）。飛ばしたことを記録する
        if (onceRecognitionRunning) {
          logEvent('recognition_once_previous_end_pending', s.id)
          if (expDiag?.recognitionOnce) pushBounded(expDiag.recognitionOnce.skippedPendingEnd, { sessionId: s.id, at: perfNow() })
          return
        }
        if (!onceRecognition) {
          onceRecognition = new RecognitionCtor()
          if (expDiag?.recognitionOnce) expDiag.recognitionOnce.createdCount += 1
        }
        recognition = onceRecognition
      } else {
        recognition = new RecognitionCtor()
      }
      recognition.lang = speechCode
      recognition.interimResults = true
      recognition.continuous = true
      recognition.onresult = (event) => {
        if (config.recogOnce) recordOnce('result', s.id)
        if (!isActive(s.id)) {
          if (s.exp) pushBounded(s.exp.recognition.events, { type: 'result_stale', at: perfNow() })
          return
        }
        let transcript = ''
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript
        }
        // 実験の記録は文字数だけ（認識した本文は残さない）
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'result', at: perfNow(), chars: transcript.length })
        s.diag.recognition.hadResult = true
        s.diag.recognition.chars = transcript.length
        callbacks().onTranscript(transcript)
      }
      recognition.onerror = (event) => {
        if (config.recogOnce) recordOnce('error', s.id)
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'error', at: perfNow(), error: event?.error ?? 'unknown' })
        if (!isActive(s.id)) return
        logEvent(`recognition_error:${event?.error ?? 'unknown'}`, s.id)
      }
      recognition.onend = () => {
        // 実験の recogonce：前の実行が終わった（どのセッションの handler でも）
        if (config.recogOnce) onceRecognitionRunning = false
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'end', at: perfNow() })
        if (config.recogOnce) recordOnce('end', s.id)
        // 実験の recogfirst：利用者の停止で end を待っていれば、ここで待ちを解く。下の「始め直してよいか」の判定は、
        // 止める指示の後や s.recognition を空にした後に早く戻るので、その前に置く
        if (config.recogFirst) settleRecognitionEndWait(s, recognition)
        // 実験の legacyrecog：PR #26 の前（07f06f0）と同じく、MediaRecorder が recording なら始め直す。
        // 07f06f0 では、止める指示と MediaRecorder の stop() が同じ同期の処理の中にあったので、「recording なら」は
        // 「止める指示が出ていなければ」と同じだった。awaitclose と組み合わせると、その間に close() を待つので、
        // 止める指示の後には始め直さない条件を足して、同じ意味を保つ
        if (config.legacyRecog) {
          if (s.recorder?.state === 'recording' && !s.stopRequested) {
            if (s.exp) pushBounded(s.exp.recognition.events, { type: 'start_call', at: perfNow() })
            try { recognition.start() } catch { /* ignore */ }
          }
          return
        }
        // 始め直すのは、自分のセッションが有効で、画面が recording で、止める指示が出ていないときだけ
        if (!isActive(s.id) || s.stopRequested || s.recognition !== recognition || !callbacks().isRecordingStatus()) return
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'start_call', at: perfNow() })
        if (config.recogOnce) {
          recordOnce('start_call', s.id)
          try {
            recognition.start()
            onceRecognitionRunning = true
          } catch { /* 始め直しの失敗は捨てる */ }
          return
        }
        try { recognition.start() } catch { /* 始め直しの失敗は捨てる */ }
      }
      // 実験の trace：今の版にない出来事だけ、新しく listener を付ける
      if (config.trace && s.exp) {
        const exp = s.exp
        const record = (type: string) => () => { pushBounded(exp.recognition.events, { type, at: perfNow() }) }
        recognition.onstart = record('start')
        recognition.onaudiostart = record('audiostart')
        recognition.onaudioend = record('audioend')
      }
      if (config.legacyRecog) {
        // 実験の legacyrecog：PR #26 の前と同じく、start() が成功した後に ref に入れる（例外なら ref は空のまま）
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'start_call', at: perfNow() })
        recognition.start()
        s.recognition = recognition
      } else {
        s.recognition = recognition
        if (s.exp) pushBounded(s.exp.recognition.events, { type: 'start_call', at: perfNow() })
        if (config.recogOnce) recordOnce('start_call', s.id)
        recognition.start()
        if (config.recogOnce) onceRecognitionRunning = true
      }
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
      recognitionEndWait: null,
      chunks: [],
      mimeType: '',
      diag: newDiagnostics(id),
      exp: expDiag ? newExperimentSessionTrace(id, config) : null,
    }
    activeId = id
    current = s
    diagnostics.sessions.push(s.diag)
    if (diagnostics.sessions.length > MAX_DIAGNOSTIC_SESSIONS) diagnostics.sessions.shift()
    if (expDiag && s.exp) addExperimentSession(expDiag, s.exp)

    // 実験の recogearly：音声認識を getUserMedia の前に始める。録音の成立までの失敗や中断では、片付け（release）の
    // stopRecognition で止める（recogabort があれば abort()）
    if (config.recogEarly) startRecognition(s, speechCode)
    s.diag.getUserMedia.startedAt = now()
    logEvent('get_user_media_start', id)
    let stream: MediaStream
    if (s.exp) s.exp.getUserMediaCalledAt = perfNow()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      // 待っている間に中断された。取得した stream はその場で閉じ、何もしない
      stream.getTracks().forEach(t => t.stop())
      logEvent('stale_get_user_media_stopped', id)
      return
    }
    s.stream = stream
    s.diag.getUserMedia.succeededAt = now()
    logEvent('get_user_media_succeeded', id)

    try {
      const tracks = stream.getAudioTracks()
      // 実験の notrackread：getAudioTracks() は呼ぶが、track の readyState、enabled、muted を読まず（診断の tracks は空のまま）、
      // live でないときの失敗の判定もしない。track がないときの失敗の判定は残す
      if (!config.noTrackRead) {
        s.diag.tracks = tracks.map(t => ({ readyState: t.readyState, enabled: t.enabled, muted: t.muted }))
      }
      if (tracks.length === 0) throw new DOMException('no audio track', 'NoAudioTrackError')
      if (!config.noTrackRead) {
        if (tracks.some(t => t.readyState !== 'live')) throw new DOMException('audio track is not live', 'TrackNotLiveError')
      }

      s.mimeType = getSupportedMimeType()
      const recorder = new MediaRecorder(stream, s.mimeType ? { mimeType: s.mimeType } : undefined)
      s.recorder = recorder
      recorder.ondataavailable = (e) => {
        if (s.exp) pushBounded(s.exp.recorder.data, { at: perfNow(), size: e.data.size, activeSession: isActive(id) })
        // 無効なセッションのデータは捨てる
        if (!isActive(id)) return
        if (e.data.size > 0) {
          s.chunks.push(e.data)
          s.diag.recorder.bytes += e.data.size
        }
      }
      recorder.onstop = () => {
        if (s.exp) s.exp.recorder.onstopAt = perfNow()
        s.recorderStopped = true
        // 利用者の停止から onstop までの時間を残す（見張りのタイマーの時間を実測で見直すため。片付けた後に届いた場合も）
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
      // 実験の trace：今の版にない出来事（MediaRecorder の onstart）だけ、新しく listener を付ける
      if (config.trace && s.exp) {
        const exp = s.exp
        recorder.onstart = () => { exp.recorder.onstartAt = perfNow() }
      }
      if (s.exp) s.exp.recorder.startCalledAt = perfNow()
      recorder.start()
      // 録音の途中で track が終わったこと（ほかのアプリがマイクを使った、OS が止めたなど）を診断のログに残す。
      // 録音の失敗の扱いは、その後に MediaRecorder が自分で止まったとき（onstop）に行う。
      // 実験の noendedlistener：ended の listener を付けない
      if (!config.noEndedListener) {
        tracks.forEach((track, i) => {
          track.addEventListener('ended', () => {
            // 実験の trace：もともとある handler の中で記録する
            if (config.trace && s.exp) pushBounded(s.exp.trackEvents, { type: 'ended', at: perfNow(), track: i })
            // 古いセッションと、利用者の停止や中断の後（自分で止めた結果）は何もしない
            if (!isActive(id) || s.stopRequested) return
            if (s.diag.tracks[i]) s.diag.tracks[i].readyState = 'ended'
            logEvent('track_ended', id)
          })
        })
      }
      // 実験の trace：今の版にない出来事（track の mute と unmute）だけ、新しく listener を付ける
      if (config.trace && s.exp) {
        const exp = s.exp
        tracks.forEach((track, i) => {
          const record = (type: string) => () => { pushBounded(exp.trackEvents, { type, at: perfNow(), track: i }) }
          track.addEventListener('mute', record('mute'))
          track.addEventListener('unmute', record('unmute'))
        })
      }
      s.diag.recorder.state = recorder.state
      s.diag.recorder.mimeType = recorder.mimeType || s.mimeType || null
      s.diag.recorder.startedAt = now()
    } catch (e) {
      const name = errorName(e)
      s.diag.recorder.errorName = name
      logEvent(`recording_start_failed:${name}`, id)
      // 開いた stream を必ず閉じる
      void teardown(s, 'error')
      callbacks().onStartFailed('recording_start_failed', name)
      return
    }

    logEvent('recording_started', id)
    callbacks().onRecordingStarted()
    if (!isActive(id)) return
    // 補助の機能は、録音の成立の後に開始を試みる。失敗しても録音は続ける。
    // 実験の nometer：音量の取得（AudioContext、analyser、requestAnimationFrame）を一切使わない。
    // 実験の norecog：音声認識を一切作らない（constructor も呼ばない）。
    // 実験の recogearly：getUserMedia の前に始めているので、ここでは始めない（2回始めない）
    if (!config.noMeter) startLevelMeter(s, stream)
    if (!config.noRecog && !config.recogEarly) startRecognition(s, speechCode)
  }

  // 利用者の停止。止める指示を先に記録してから、音声認識と音量の取得を止め、MediaRecorder の onstop を待つ。
  // 音量の取得の資源（AudioContext など）は、MediaRecorder の stop() より前に片付ける（順番の理由は releaseLevelMeter。
  // close() の完了は待たない）。track は onstop の後の片付けで止める。
  // 録音のデータは、最後の ondataavailable の後の onstop でまとめる（timeslice なしの録音では、最後のデータが録音の全体）
  const stop = () => {
    const s = current
    // onstop が利用者の停止の前に届いていた場合（録音が先に止まっていた場合）は、onstop の時点で録音の失敗として
    // 片付けて、セッションが無効になっているので、ここには来ない（JJ5）
    if (!s || s.stopRequested || !s.recorder) return
    s.stopRequested = true
    s.stopReason = 'user'
    s.diag.stopReason = 'user'
    logEvent('user_stop', s.id)
    if (config.recogFirst) {
      stopRecognitionFirst(s)
      return
    }
    stopRecognition(s)
    stopLevelMeter(s)
    const levelMeterClosed = releaseLevelMeter(s)
    const recorder = s.recorder
    if (config.awaitClose) {
      // 実験の awaitclose：AudioContext の close() の完了を待ってから MediaRecorder の stop() を呼ぶ。待っている間に
      // セッションが無効になったとき（中断など）は、stop() を呼ばずに終える（中断の片付けに任せる）。
      // close() が終わらないままにならないよう、見張りのタイマーは待つ前に始める
      startStopWatchdog(s, now())
      void levelMeterClosed.then(() => {
        if (!isActive(s.id)) return
        stopRecorder(s, recorder)
      })
      return
    }
    stopRecorder(s, recorder)
  }

  // 実験の recogfirst の利用者の停止（stop の後半）。音声認識の stop()（recogabort なら abort()）を呼んだ後、
  // end が届くのを待ってから MediaRecorder の stop() を呼ぶ。音量の取得の片付けは、今と同じく MediaRecorder の stop() の前
  // （end を待つ前）に始める。awaitclose があれば、end の後に close() の完了も待つ。見張りのタイマーは待つ前に始める
  const stopRecognitionFirst = (s: Session) => {
    const recognition = s.recognition
    const recorder = s.recorder as MediaRecorder
    startStopWatchdog(s, now())
    stopRecognition(s)
    stopLevelMeter(s)
    const levelMeterClosed = releaseLevelMeter(s)
    const proceed = () => {
      // 待っている間にセッションが無効になったとき（中断など）は、片付けで待ちを無効にしているので、ここには来ない。
      // 念のため確かめ、無効なら stop() を呼ばずに終える（中断の片付けに任せる）
      if (!isActive(s.id)) return
      if (config.awaitClose) {
        void levelMeterClosed.then(() => {
          if (isActive(s.id)) stopRecorder(s, recorder)
        })
      } else {
        stopRecorder(s, recorder)
      }
    }
    if (!recognition) {
      // 音声認識がない（作れなかった、start() が失敗したなど）ので、届く end がない。待たずに進む
      if (s.exp?.recognitionEndWait) s.exp.recognitionEndWait.noRecognition = true
      proceed()
      return
    }
    // end は stop() の中ではなく、後のタスクで届く（イベントは同期で配られない）ので、同じ同期の処理の中で stop() の後に
    // 待ちを作っても取りこぼさない
    waitRecognitionEnd(s, recognition, proceed)
  }

  const waitRecognitionEnd = (s: Session, recognition: SpeechRecognition, proceed: () => void) => {
    const wait: RecognitionEndWait = { recognition, sessionId: s.id, state: 'waiting', timer: null, proceed }
    s.recognitionEndWait = wait
    if (s.exp?.recognitionEndWait) s.exp.recognitionEndWait.waitStartedAt = perfNow()
    wait.timer = setTimeout(() => {
      wait.timer = null
      // 待ちを解いたときと中断したときはタイマーを取り消しているので、waiting のままのはず（念のため確かめる）
      if (wait.state === 'waiting') timeOutRecognitionEndWait(s, wait)
    }, RECOGNITION_END_TIMEOUT_MS)
  }

  // 1.5 秒で見切る。見切った待ちは無効にする（後から届いた end は記録だけ）
  const timeOutRecognitionEndWait = (s: Session, wait: RecognitionEndWait) => {
    wait.state = 'timedout'
    if (s.exp?.recognitionEndWait) {
      s.exp.recognitionEndWait.recognitionEndTimedOut = true
      s.exp.recognitionEndWait.timedOutAt = perfNow()
    }
    logEvent('recognition_end_timeout', s.id)
    wait.proceed()
  }

  // 音声認識の onend から呼ぶ。自分の部品と、待ちを始めたときのセッションの番号が一致する待ちだけを解く
  const settleRecognitionEndWait = (s: Session, recognition: SpeechRecognition) => {
    const wait = s.recognitionEndWait
    if (!wait || wait.recognition !== recognition || wait.sessionId !== s.id) return
    if (wait.state === 'timedout') {
      if (s.exp?.recognitionEndWait && s.exp.recognitionEndWait.lateEndAt === null) s.exp.recognitionEndWait.lateEndAt = perfNow()
      return
    }
    if (wait.state !== 'waiting') return
    if (wait.timer !== null) {
      clearTimeout(wait.timer)
      wait.timer = null
    }
    if (s.exp?.recognitionEndWait) s.exp.recognitionEndWait.endAt = perfNow()
    // 実験の recogdelay：end の後、さらに 500 ミリ秒待つ
    if (config.recogDelay) {
      wait.state = 'delaying'
      wait.timer = setTimeout(() => {
        wait.timer = null
        // 中断したときはタイマーを取り消しているので、delaying のままのはず（念のため確かめる）
        if (wait.state === 'delaying') {
          wait.state = 'done'
          if (s.exp?.recognitionEndWait) s.exp.recognitionEndWait.delayEndedAt = perfNow()
          wait.proceed()
        }
      }, RECOGNITION_END_DELAY_MS)
      return
    }
    wait.state = 'done'
    wait.proceed()
  }

  // 片付け（release）から呼ぶ。待っている間（waiting、delaying）なら待ちを無効にし、タイマーを取り消す
  const cancelRecognitionEndWait = (s: Session) => {
    const wait = s.recognitionEndWait
    if (!wait) return
    if (wait.timer !== null) {
      clearTimeout(wait.timer)
      wait.timer = null
    }
    if (wait.state === 'waiting' || wait.state === 'delaying') {
      wait.state = 'cancelled'
      if (s.exp?.recognitionEndWait) s.exp.recognitionEndWait.cancelledAt = perfNow()
    }
  }

  // 利用者の停止で MediaRecorder を止め、onstop を待つ見張りのタイマーを始める（stop の後半）
  const stopRecorder = (s: Session, recorder: MediaRecorder) => {
    const stopRequestedAt = now()
    s.diag.recorder.stopRequestedAt = stopRequestedAt
    if (recorder.state === 'inactive') {
      // MediaRecorder が自分で inactive になり、dataavailable と stop のイベントがまだ届いていない。onstop を待つ
      logEvent('recorder_already_inactive', s.id)
    } else {
      try {
        if (s.exp) s.exp.recorder.stopCalls.push({ at: perfNow(), by: 'user' })
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
    startStopWatchdog(s, stopRequestedAt)
  }

  // onstop を待つ見張りのタイマー。すでに始めているとき（実験の awaitclose）は始め直さない
  const startStopWatchdog = (s: Session, stopRequestedAt: number) => {
    if (s.stopTimer !== null) return
    s.stopTimer = setTimeout(() => {
      s.stopTimer = null
      // 古いセッションのタイマーは何もしない（片付けで止めているが、念のため確かめる）
      if (!isActive(s.id)) return
      s.diag.recorder.stopTimedOut = true
      s.diag.recorder.stopWaitedMs = now() - stopRequestedAt
      failRecording(s, 'recorder_stop_timeout')
    }, RECORDER_STOP_TIMEOUT_MS)
  }

  // 中断の片付け。今有効なセッションを先に無効にしてから、資源を片付ける。録音のデータは送らない
  const abort = (reason: AudioSessionAbortReason): Promise<void> => {
    // 実験の recogonce：画面が外れるときは、セッションを片付けて部品を止めた後に、画面で1つの部品を手放す
    if (config.recogOnce && reason === 'unmount') {
      const closed = abortSession(reason)
      disposeOnceRecognition()
      return closed
    }
    return abortSession(reason)
  }

  const abortSession = (reason: AudioSessionAbortReason): Promise<void> => {
    const s = current
    current = null
    activeId = null
    if (!s) return Promise.resolve()
    logEvent(`abort:${reason}`, s.id)
    return teardown(s, reason)
  }

  // 実験の recogonce：画面で1つの部品を手放す。部品を start() するのは有効なセッションの中だけで、セッションの片付け
  // （release の stopRecognition）が必ず止める（recogabort なら abort()）。画面が外れるときは、abort の中で今のセッションを
  // 片付けた後にここを呼ぶので、部品はすでに止まっている。ここでは参照を捨てるだけにする（止めた部品をもう一度止めない）。
  // 前の実行が終わっていないかの変数も、初期の値に戻す
  const disposeOnceRecognition = () => {
    if (!onceRecognition) return
    onceRecognition = null
    onceRecognitionRunning = false
    if (expDiag?.recognitionOnce) expDiag.recognitionOnce.disposedAt = perfNow()
  }

  return {
    start,
    stop,
    abort,
    hasActiveSession: () => current !== null,
    logEvent: (type: string) => logEvent(type),
    getDiagnostics: () => {
      const result: AudioDiagnostics = { sessions: [...diagnostics.sessions], events: [...diagnostics.events] }
      if (expDiag) result.experiment = cloneExperimentDiagnostics(expDiag)
      return result
    },
    setCallbacks: (next: AudioSessionCallbacks) => { latestCallbacks = next },
    recordPageEvent: (type: string, persisted?: boolean) => {
      if (!expDiag || !config.trace) return
      addPageEvent(expDiag, { type, at: perfNow(), visibilityState: document.visibilityState, ...(persisted === undefined ? {} : { persisted }) })
    },
    markTraceListenerOnly: () => { if (expDiag) expDiag.traceListenerOnly = true },
  }
}

// 画面から使う hook。返す AudioSession は、画面が外れるまで同じもの。
// callback は、描画のたびに useLayoutEffect で最新のものに入れ替える（描画の直後、ブラウザのイベントより前に入れ替わる）。
// hook に渡す callback の中では、React の状態（useState の値）を読まず、ref（statusRef など）を読むこと。
// 非同期の callback が呼ばれる時点では、closure の中の状態は古いことがあるため
// config（切り分けの実験のスイッチ）は、最初の描画のときの値だけを使う
export function useAudioSession(callbacks: AudioSessionCallbacks, config: ExperimentConfig = DEFAULT_EXPERIMENT_CONFIG): AudioSession {
  const [session] = useState(() => createAudioSession(callbacks, config))
  useLayoutEffect(() => {
    session.setCallbacks(callbacks)
  })
  return session
}
