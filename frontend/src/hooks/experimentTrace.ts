import type { ExperimentConfig, InactiveExperiment, ExperimentName } from '../experiments'

// 切り分けの実験の診断（docs/testing.md の「実験のスイッチ」）。URL に exp があるときだけ作り、ないときは何も記録しない。
// 時刻はすべて performance.now()（requestAnimationFrame の timestamp と同じ基準）。
// 認識した本文は記録しない（出来事の名前、時刻、エラーの文字列、文字数だけ）。
// 原因が分かったら、このファイルは外す

const MAX_TRACE_SESSIONS = 10
const MAX_EVENTS_PER_SESSION = 200
const MAX_PAGE_EVENTS = 200

export interface ExperimentRecognitionEvent {
  // start_call、stop_call、（recogabort）abort_call、result、result_stale、error、end、（trace）start、audiostart、audioend
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
  // recogfirst のときだけ（ほかは null）。利用者の停止で、音声認識の end を待った記録
  recognitionEndWait: ExperimentRecognitionEndWait | null
  // recogearly のときだけ（ほかは null）。録音の成立の前の失敗や中断で、先に始めた音声認識を止めた時刻
  recogEarly: { stoppedBeforeRecordingAt: number | null } | null
}

export interface ExperimentRecognitionEndWait {
  // end を待ち始めた時刻（音声認識の stop() か abort() を呼ぶ直前）
  waitStartedAt: number | null
  // 音声認識がなかった（作れなかった、start() が失敗したなど）ので、待たずに MediaRecorder を止めた
  noRecognition: boolean
  // 待っている間に届いた end の時刻
  endAt: number | null
  // 1.5 秒で見切ったか（見張りのタイマーの見切り recorder.stopTimedOut とは別）と、見切った時刻
  recognitionEndTimedOut: boolean
  timedOutAt: number | null
  // 見切った後に届いた end の時刻（記録だけで、録音の処理には作用させない）
  lateEndAt: number | null
  // （recogdelay）end の後の 500 ミリ秒の待ちが終わった時刻
  delayEndedAt: number | null
  // 待っている間に中断して、待ちを無効にした時刻
  cancelledAt: number | null
}

// recogonce のときだけ。部品は画面で1つなので、セッションではなく画面の単位で記録する
export interface ExperimentRecognitionOnce {
  // 音声認識の constructor を呼んだ回数（1 のはず）
  createdCount: number
  // 画面が外れるとき（unmount）に部品を手放した時刻
  disposedAt: number | null
  // 出来事ごとの、結び付けたセッションの番号と、そのときの有効なセッションの番号（null は、有効なセッションがない）。
  // 2つが一致しない出来事は、記録だけで、録音の処理には作用させない
  events: { type: string; at: number; boundSessionId: number; activeSessionId: number | null }[]
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
  // recogonce のときだけ（ほかは null）
  recognitionOnce: ExperimentRecognitionOnce | null
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
    recognitionOnce: config.recogOnce ? { createdCount: 0, disposedAt: null, events: [] } : null,
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
    recognitionEndWait: config.recogFirst
      ? {
        waitStartedAt: null, noRecognition: false, endAt: null, recognitionEndTimedOut: false, timedOutAt: null, lateEndAt: null,
        delayEndedAt: null, cancelledAt: null,
      }
      : null,
    recogEarly: config.recogEarly ? { stoppedBeforeRecordingAt: null } : null,
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
