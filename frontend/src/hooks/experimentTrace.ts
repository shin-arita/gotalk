import type { ExperimentConfig, InactiveExperiment, ExperimentName } from '../experiments'

// 切り分けの実験の診断（docs/testing.md の「実験のスイッチ」）。URL に exp があるときだけ作り、ないときは何も記録しない。
// 時刻はすべて performance.now()（requestAnimationFrame の timestamp と同じ基準）。
// 認識した本文は記録しない（出来事の名前、時刻、エラーの文字列、文字数だけ）。
// 原因が分かったら、このファイルは外す

const MAX_TRACE_SESSIONS = 10
const MAX_EVENTS_PER_SESSION = 200
const MAX_PAGE_EVENTS = 200

export interface ExperimentRecognitionEvent {
  // start_call、stop_call、result、error、end、（trace）start、audiostart、audioend
  type: string
  at: number
  error?: string
  chars?: number
}

export interface ExperimentTrackEvent {
  // ended、（trace）mute、unmute
  type: string
  at: number
  track: number
}

export interface ExperimentSessionTrace {
  id: number
  // 人が見るための目印。セッションの開始のときの Date.now() と performance.now() の組
  clock: { dateNow: number; performanceNow: number }
  getUserMediaCalledAt: number | null
  // notrackread のときは false（track の readyState、enabled、muted を読んでいない）
  tracksRead: boolean
  audioContext: {
    createdAt: number | null
    sourceConnectedAt: number | null
    disconnectedAt: number | null
    // nodisconnect で disconnect() を呼ばなかった
    disconnectSkipped: boolean
    closeCalledAt: number | null
    closeResolvedAt: number | null
  }
  recorder: {
    startCalledAt: number | null
    // （trace）onstart
    onstartAt: number | null
    // stop() を呼んだ時刻。by は user（利用者の停止）か cleanup（片付け）
    stopCalls: { at: number; by: 'user' | 'cleanup' }[]
    // ondataavailable の回ごとの時刻と大きさ。activeSession は、そのときセッションが有効だったか（無効なら捨てた）
    data: { at: number; size: number; activeSession: boolean }[]
    onstopAt: number | null
    // 利用者の停止で画面に渡した Blob の大きさ（ondataavailable の合計とは別に）
    blobSize: number | null
  }
  level: {
    // requestAnimationFrame の timestamp
    firstSampleAt: number | null
    firstNonZeroAt: number | null
  }
  recognition: { events: ExperimentRecognitionEvent[] }
  trackEvents: ExperimentTrackEvent[]
}

export interface ExperimentPageEvent {
  type: string
  at: number
  visibilityState: string
  persisted?: boolean
}

export interface ExperimentDiagnostics {
  config: {
    raw: string | null
    requested: ExperimentName[]
    ignored: string[]
    inactive: InactiveExperiment[]
    effective: ExperimentName[]
  }
  // nolifecycle と trace を一緒に指定したとき、記録のためだけの listener を付けた（本来の処理はしない）
  traceListenerOnly: boolean
  // noendedlistener と trace を一緒に指定したとき、ended の listener を付けないので、ended は記録しない
  endedNotRecorded: string | null
  // （trace）visibilitychange、pagehide、pageshow
  pageEvents: ExperimentPageEvent[]
  sessions: ExperimentSessionTrace[]
}

export function newExperimentDiagnostics(config: ExperimentConfig): ExperimentDiagnostics {
  return {
    config: {
      raw: config.raw,
      requested: [...config.requested],
      ignored: [...config.ignored],
      inactive: config.inactive.map(i => ({ ...i })),
      effective: [...config.effective],
    },
    traceListenerOnly: false,
    endedNotRecorded: config.trace && config.noEndedListener ? 'noendedlistener のため ended は記録しない' : null,
    pageEvents: [],
    sessions: [],
  }
}

export function newExperimentSessionTrace(id: number, config: ExperimentConfig): ExperimentSessionTrace {
  return {
    id,
    clock: { dateNow: Date.now(), performanceNow: performance.now() },
    getUserMediaCalledAt: null,
    tracksRead: !config.noTrackRead,
    audioContext: {
      createdAt: null,
      sourceConnectedAt: null,
      disconnectedAt: null,
      disconnectSkipped: false,
      closeCalledAt: null,
      closeResolvedAt: null,
    },
    recorder: { startCalledAt: null, onstartAt: null, stopCalls: [], data: [], onstopAt: null, blobSize: null },
    level: { firstSampleAt: null, firstNonZeroAt: null },
    recognition: { events: [] },
    trackEvents: [],
  }
}

export function addExperimentSession(diag: ExperimentDiagnostics, trace: ExperimentSessionTrace) {
  diag.sessions.push(trace)
  if (diag.sessions.length > MAX_TRACE_SESSIONS) diag.sessions.shift()
}

export function pushBounded<T>(list: T[], item: T, max = MAX_EVENTS_PER_SESSION) {
  list.push(item)
  if (list.length > max) list.shift()
}

export function addPageEvent(diag: ExperimentDiagnostics, event: ExperimentPageEvent) {
  pushBounded(diag.pageEvents, event, MAX_PAGE_EVENTS)
}

// 読み取り用の複製（JSON にできる値だけなので、structuredClone を使わずに JSON で写す）
export function cloneExperimentDiagnostics(diag: ExperimentDiagnostics): ExperimentDiagnostics {
  return JSON.parse(JSON.stringify(diag)) as ExperimentDiagnostics
}
