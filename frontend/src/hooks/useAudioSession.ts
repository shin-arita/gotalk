import { useLayoutEffect, useState } from 'react'

// 通訳の画面の録音のセッション（docs/speech-flow.md）。getUserMedia、track の stop()、MediaRecorder、音声認識、
// 音量の取得（AudioContext と analyser、requestAnimationFrame）を、ここにまとめる。
// 画面の状態（InterpreterStatus）は持たない。持つのは、録音の資源とセッションの番号だけで、
// 「録音が成立した」「録音の最後のデータがそろった」「失敗した」などを callback で画面に知らせる

// 中断の理由。利用者の停止（user）とは別に、セッションを先に無効にして、録音のデータを送らずに片付ける
export type AudioSessionAbortReason = 'hidden' | 'pagehide' | 'back' | 'unmount' | 'error'
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

// 利用者の停止で、MediaRecorder の onstop を待つ最長の時間（ミリ秒）。届かないままだと stopping のままマイクが
// 開き続けるので、この時間で見切りを付けて録音の失敗として片付ける。
// 実機で確かめていない仮の値。短すぎると正常な長い録音（古い端末の audio/mp4 で上限に近い録音など）を捨て、
// 長すぎるとブラウザの不具合で onstop が届かないときに track が長く開いているだけなので、損失の小さい長めの値にしている。
// PR 2 の診断の表示で stop() から onstop までの時間（AudioSessionDiagnostics の recorder.stopLatencyMs）を測り、
// 実測の値に余裕を足した値に見直す
export const RECORDER_STOP_TIMEOUT_MS = 10_000

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
  chunks: Blob[]
  mimeType: string
  diag: AudioSessionDiagnostics
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
// （React の closure の古い値を使わないため）
export function createAudioSession(initialCallbacks: AudioSessionCallbacks): AudioSession {
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

  // releaseLevelMeter の1回目の中身。source node を disconnect() し、AudioContext の close() を始める
  const closeLevelMeter = (s: Session): Promise<void> => {
    if (s.sourceNode) {
      try { s.sourceNode.disconnect() } catch { /* 捨てる */ }
    }
    s.sourceNode = null
    s.analyser = null
    const audioContext = s.audioContext
    s.audioContext = null
    if (!audioContext || audioContext.state === 'closed') return Promise.resolve()
    try {
      return audioContext.close()
        .catch(() => { /* close() の拒否は捨てる */ })
        .finally(() => { s.diag.audioContext.state = audioContext.state })
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
    stopRecognition(s)
    stopLevelMeter(s)
    const closed = releaseLevelMeter(s)
    const recorder = s.recorder
    s.recorder = null
    if (recorder && recorder.state !== 'inactive') {
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

    s.diag.getUserMedia.startedAt = now()
    logEvent('get_user_media_start', id)
    let stream: MediaStream
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
      recorder.start()
      // 録音の途中で track が終わったこと（ほかのアプリがマイクを使った、OS が止めたなど）を診断のログに残す。
      // 録音の失敗の扱いは、その後に MediaRecorder が自分で止まったとき（onstop）に行う
      tracks.forEach((track, i) => {
        track.addEventListener('ended', () => {
          // 古いセッションと、利用者の停止や中断の後（自分で止めた結果）は何もしない
          if (!isActive(id) || s.stopRequested) return
          if (s.diag.tracks[i]) s.diag.tracks[i].readyState = 'ended'
          logEvent('track_ended', id)
        })
      })
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
    // 補助の機能は、録音の成立の後に開始を試みる。失敗しても録音は続ける
    startLevelMeter(s, stream)
    startRecognition(s, speechCode)
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
    stopRecognition(s)
    stopLevelMeter(s)
    void releaseLevelMeter(s)
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

  // 中断の片付け。今有効なセッションを先に無効にしてから、資源を片付ける。録音のデータは送らない
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
    getDiagnostics: () => ({ sessions: [...diagnostics.sessions], events: [...diagnostics.events] }),
    setCallbacks: (next: AudioSessionCallbacks) => { latestCallbacks = next },
  }
}

// 画面から使う hook。返す AudioSession は、画面が外れるまで同じもの。
// callback は、描画のたびに useLayoutEffect で最新のものに入れ替える（描画の直後、ブラウザのイベントより前に入れ替わる）。
// hook に渡す callback の中では、React の状態（useState の値）を読まず、ref（statusRef など）を読むこと。
// 非同期の callback が呼ばれる時点では、closure の中の状態は古いことがあるため
export function useAudioSession(callbacks: AudioSessionCallbacks): AudioSession {
  const [session] = useState(() => createAudioSession(callbacks))
  useLayoutEffect(() => {
    session.setCallbacks(callbacks)
  })
  return session
}
