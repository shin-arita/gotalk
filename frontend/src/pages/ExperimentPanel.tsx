import { useState } from 'react'
import type { ExperimentConfig } from '../experiments'
import type { AudioDiagnostics } from '../hooks/useAudioSession'
import type { ExperimentRecognitionOnce } from '../hooks/experimentTrace'

// 切り分けの実験の診断の表示（docs/testing.md の「実験のスイッチ」）。URL に exp があるときだけ描画する。
// 表示は「更新」を押したときだけ、そのときの診断の情報（スナップショット）を読んで変える。
// 定期的な読み取り、新しい timer、出来事ごとの React の状態の更新はしない（診断が、調べている動きを変えないため）。
// 開発用の表示なので、文言は日本語だけにしている。原因が分かったら、このファイルは外す

const SHOWN_SESSIONS = 5
// legacymute：表示する読み上げの記録の数
const SHOWN_TTS_PLAYS = 5

// legacy（PR #26 の前の通訳の画面）の最小限の記録。録音ごとに1つ。
// 07f06f0 にもともとある ondataavailable と onstop の中の値と、start() と stop() を呼んだ時刻だけ
// （MediaRecorder の property は読まない）
export interface LegacyRecording {
  // performance.now()
  startCalledAt: number | null
  stopCalledAt: number | null
  // ondataavailable の回ごとの大きさ
  dataSizes: number[]
  // onstop で作った Blob の大きさと type（利用者の停止のときだけ）
  blobSize: number | null
  blobType: string | null
  // legacykeep のときだけ持つ（legacy のときは持たない）
  keepStream?: LegacyKeepStream
}

// legacykeep（legacy に、マイクの使い回しだけを加えたもの）の録音ごとの記録
export interface LegacyKeepStream {
  // この録音で、持っている stream を使い回したか（false は getUserMedia を呼んだ）
  streamReused: boolean
  // 画面を開いてから getUserMedia を呼んだ回数の合計（この録音の分を含む）
  getUserMediaCalls: number
  // 使い回すかを決めたときの、持っている stream の track の状態（readyState/enabled/muted。持っていないときは空）。
  // 判定に使うのは readyState だけ
  trackStates: string[]
  // 波紋の表示の tick で取った RMS の最大値と、0 でない値を取った回数、tick の回数
  rmsMax: number
  rmsNonZeroSamples: number
  rmsSamples: number
  // 音量の取得の AudioContext の、作った直後の state、最初の tick での state（tick が回らなかったときは null）、
  // 作成から analyser までのつなぎで出た例外の name（出なかったときは null）
  audioContextState: string | null
  audioContextFirstTickState: string | null
  audioContextError: string | null
  // 音声認識の文字を付けて Backend に送ったか（Backend に送らなかった録音は null）
  transcriptSent: boolean | null
  // legacymute のときだけ持つ（legacykeep のときは持たない）
  // 画面を開いてから何回目の録音か（1から。録音の記録が成立したときに数える）
  recordingNo?: number
  // 録音の開始で track を有効に戻した直後の状態（getUserMedia を呼んだときは、新しい track の状態）
  trackStatesAfterEnable?: string[]
  // onstop で track を無効にした直後の状態（onstop が来るまでは空）
  trackStatesAfterDisable?: string[]
}

// legacymute の読み上げの記録。play() を呼んだ回ごとに1つ（画面ごとに直近の 10 件）
export interface LegacyTtsPlay {
  // 直前の録音の recordingNo（録音がまだないときは null）
  afterRecordingNo: number | null
  // play() を呼ぶ直前の track の状態（readyState/enabled/muted。持っていないときは空）
  trackStatesBeforePlay: string[]
  // performance.now()
  playCalledAt: number
  // play() が解決したら 'resolved'、例外なら例外の name。結果が出るまでは null
  playResult: string | null
  // onended と onerror が来たか
  ended: boolean
  error: boolean
}

// recogonly：出来事の種類
export type RecogOnlyEventType =
  | 'start'        // start() を呼んだ（by で、利用者の操作の中か外かを分ける）
  | 'audiostart' | 'soundstart' | 'speechstart' | 'speechend' | 'soundend' | 'audioend'
  | 'result'
  | 'error'
  | 'end'
  | 'stop'         // 利用者の終了で stop() を呼んだ
  | 'abort'        // abort() を呼んだ

export interface RecogOnlyEvent {
  type: RecogOnlyEventType
  // 発話の開始（RecogOnlyRecording.utteranceStartedAt）からの ms（performance.now() の差。整数に丸める）
  at: number
  // start のときだけ：'gesture'（国旗のタップの中）か 'restart'（自動の始め直し）
  by?: 'gesture' | 'restart'
  // error のときだけ：event.error
  error?: string
  // end のときだけ：その時の phase（'listening' は自動の終わり、'stopping' は利用者の終了の後、'finished' は終了の後に来たもの）
  phase?: 'listening' | 'stopping' | 'finished'
}

// recogonly：終了の理由
export type RecogOnlyFinishReason =
  | 'user-stop' | 'end-timeout' | 'restart-limit' | 'restart-start-error'
  | 'not-allowed' | 'service-not-allowed' | 'unmount' | 'ctor-missing' | 'ctor-error' | 'start-error'

// recogonly：発話ごとの記録（画面ごとに直近の 20 件）
export interface RecogOnlyRecording {
  recordingNo: number                     // 画面を開いてから何回目の発話か（1から）
  lang: string                            // タップした国旗の言語の id
  recognitionCtorMissing: boolean
  utteranceStartedAt: number              // 国旗のタップで記録を作った時刻（performance.now()）。出来事の時刻の基準
  startCalledAt: number | null            // 実際に最初の recognition.start() を呼んだ時刻（performance.now()）。部品がないときは null
  stopCalledAt: number | null
  finishedAt: number | null
  startError: string | null               // 最初の start() の例外を recogErrorName() で文字列にした値（なければ null）
  stopError: string | null                // stop() の例外を recogErrorName() で文字列にした値（なければ null）
  constructorError: string | null         // new RecognitionCtor() の例外を recogErrorName() で文字列にした値（なければ null）
  events: RecogOnlyEvent[]                // 最大 300 件
  eventsDropped: number                   // 300 件を超えて残さなかった出来事の数
  autoRestarts: number                    // 自動の始め直しの start() を呼んだ回数（例外でも数える。成功した回数ではない）
  restartErrors: string[]                 // 自動の始め直しの start() の例外を recogErrorName() で文字列にした値
  restartLimitReached: boolean
  silenceBeforeAutoEndMs: (number | null)[] // 自動の onend ごとに、その認識（直前の start() から）の最後の result からの ms（その認識で result がなければ null）
  stopToEndMs: number | null              // stop() から onend まで（onend が来なければ null）
  endTimeoutFired: boolean
  finishReason: RecogOnlyFinishReason | null
  finalTextLength: number | null          // 送った（送ろうとした）文字の文字数。文字そのものは残さない
  segments: number                        // result があった認識の数（1つの認識で最初の onresult のときだけ数える）
  transcriptSent: boolean                 // /api/interpret に送ったか（fetch の直前に、transcript を付けたかで決める。送らなければ false）
  interpretResult: string | null          // 'ok'、'empty'、'language_mismatch'、エラーの値。決まるまでは null
}

// recogonly：読み上げの記録（画面ごとに直近の 10 件）
export interface RecogOnlyTtsPlay {
  afterRecordingNo: number | null
  playCalledAt: number
  playResult: string | null
  ended: boolean
  error: boolean
}

// recogonly：画面全体の記録
export interface RecogOnlyDiagnostics {
  recordings: RecogOnlyRecording[]        // 直近の 20 件すべて
  ttsPlays: RecogOnlyTtsPlay[]            // 直近の 10 件すべて
  recognitionStarts: { gesture: number; restart: number } // 画面を開いてから start() を呼んだ回数の合計
}

export type ExperimentSnapshot =
  | { kind: 'audioSession'; takenAt: string; effective: string[]; diagnostics: AudioDiagnostics }
  | { kind: 'legacy'; takenAt: string; effective: string[]; config: Pick<ExperimentConfig, 'raw' | 'requested' | 'ignored' | 'inactive' | 'effective'>; recordings: LegacyRecording[]; ttsPlays?: LegacyTtsPlay[] }
  | { kind: 'recogonly'; takenAt: string; effective: string[]; config: Pick<ExperimentConfig, 'raw' | 'requested' | 'ignored' | 'inactive' | 'effective'>; diagnostics: RecogOnlyDiagnostics }

interface ExperimentPanelProps {
  config: ExperimentConfig
  // 録音中（starting、recording、stopping）は true。ボタンを押せないようにする
  busy: boolean
  // 押したときにその場で最新の診断の情報を読む
  read: () => ExperimentSnapshot
}

const ms = (value: number | null | undefined, base: number) => (value === null || value === undefined ? '-' : `${Math.round(value - base)}ms`)

export default function ExperimentPanel({ config, busy, read }: ExperimentPanelProps) {
  const [snapshot, setSnapshot] = useState<ExperimentSnapshot | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [fallbackJson, setFallbackJson] = useState<string | null>(null)

  if (!config.enabled) return null

  const handleRefresh = () => {
    setSnapshot(read())
  }

  const handleCopy = async () => {
    const json = JSON.stringify(read(), null, 2)
    setFallbackJson(null)
    try {
      await navigator.clipboard.writeText(json)
      setCopyStatus('コピーしました')
    } catch {
      // クリップボードに写せないとき（権限がない、対応していないなど）は、選んで写せるように表示する
      setCopyStatus('コピーできませんでした。下の JSON を選んで写してください')
      setFallbackJson(json)
    }
  }

  return (
    <section className="experiment-panel" aria-label="実験の診断" style={{ margin: '16px', padding: '12px', border: '1px dashed #999', fontSize: '12px', textAlign: 'left' }}>
      <p style={{ margin: '0 0 8px' }}>
        実験：{config.effective.length > 0 ? config.effective.join(', ') : '（スイッチなし）'}
        {config.ignored.length > 0 && <> ／ 知らない名前：{config.ignored.join(', ')}</>}
        {config.inactive.length > 0 && <> ／ 効いていない：{config.inactive.map(i => `${i.name}（${i.reason}）`).join(', ')}</>}
      </p>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={handleRefresh} disabled={busy}>更新</button>
        <button type="button" onClick={() => { void handleCopy() }} disabled={busy}>コピー</button>
      </div>
      {copyStatus && <p role="status" style={{ margin: '8px 0 0' }}>{copyStatus}</p>}
      {fallbackJson !== null && (
        <textarea readOnly value={fallbackJson} aria-label="診断の JSON" rows={8} style={{ width: '100%', marginTop: '8px' }} onFocus={e => e.target.select()} />
      )}
      {snapshot && <SnapshotView snapshot={snapshot} />}
    </section>
  )
}

function SnapshotView({ snapshot }: { snapshot: ExperimentSnapshot }) {
  if (snapshot.kind === 'recogonly') return <RecogOnlyView snapshot={snapshot} />
  if (snapshot.kind === 'legacy') {
    const recordings = snapshot.recordings.slice(-SHOWN_SESSIONS)
    const mute = snapshot.effective.includes('legacymute')
    return (
      <div data-testid="experiment-snapshot">
        <p style={{ margin: '8px 0 4px' }}>{snapshot.takenAt}（{mute ? 'legacymute' : snapshot.effective.includes('legacykeep') ? 'legacykeep' : 'legacy'}）</p>
        {recordings.length === 0 && <p>録音の記録はありません</p>}
        <ol style={{ margin: 0, paddingLeft: '20px' }}>
          {recordings.map((r, i) => (
            <li key={i}>
              {`start→stop=${r.startCalledAt !== null && r.stopCalledAt !== null ? `${Math.round(r.stopCalledAt - r.startCalledAt)}ms` : '-'}、`
                + `ondataavailable=${r.dataSizes.length}回 [${r.dataSizes.join(', ')}]、Blob=${r.blobSize ?? '-'}（type=${r.blobType || '-'}）`
                + (r.keepStream
                  ? `、マイク=${r.keepStream.streamReused ? '使い回し' : 'getUserMedia'}（呼んだ回数の合計=${r.keepStream.getUserMediaCalls}、`
                    + `track=${r.keepStream.trackStates.join(', ') || '-'}）、`
                    + `RMS 最大=${r.keepStream.rmsMax.toFixed(3)}、0 でない回数=${r.keepStream.rmsNonZeroSamples}/${r.keepStream.rmsSamples}、`
                    + `AudioContext=${r.keepStream.audioContextState ?? '-'}→${r.keepStream.audioContextFirstTickState ?? '-'}`
                    + `${r.keepStream.audioContextError ? `（例外=${r.keepStream.audioContextError}）` : ''}、`
                    + `音声認識の文字=${r.keepStream.transcriptSent === null ? '送っていない' : r.keepStream.transcriptSent ? '付けた' : '付けていない'}`
                    + (mute
                      ? `、録音の番号=${r.keepStream.recordingNo ?? '-'}、有効に戻した後の track=${r.keepStream.trackStatesAfterEnable?.join(', ') || '-'}、`
                        + `無効にした後の track=${r.keepStream.trackStatesAfterDisable?.join(', ') || '-'}`
                      : '')
                  : '')}
            </li>
          ))}
        </ol>
        {mute && <TtsPlaysView plays={snapshot.ttsPlays ?? []} />}
      </div>
    )
  }

  const { diagnostics } = snapshot
  const traces = diagnostics.experiment?.sessions ?? []
  const sessions = diagnostics.sessions.slice(-SHOWN_SESSIONS)
  return (
    <div data-testid="experiment-snapshot">
      <p style={{ margin: '8px 0 4px' }}>{snapshot.takenAt}</p>
      {sessions.length === 0 && <p>録音の記録はありません</p>}
      <ol style={{ margin: 0, paddingLeft: '20px' }}>
        {sessions.map(session => {
          const trace = traces.find(t => t.id === session.id)
          const base = trace?.clock.performanceNow ?? 0
          return (
            <li key={session.id} style={{ marginBottom: '6px' }}>
              <div>セッション {session.id}：止めた理由={session.stopReason ?? '-'}、mimeType={session.recorder.mimeType ?? '-'}</div>
              <div>
                {`ondataavailable=${trace ? `${trace.recorder.data.length}回 [${trace.recorder.data.map(d => d.size).join(', ')}]` : '-'}、`
                  + `Blob=${trace?.recorder.blobSize ?? '-'}、bytes=${session.recorder.bytes}`}
              </div>
              <div>
                track={trace && !trace.tracksRead ? '読んでいない（notrackread）' : session.tracks.map(t => `${t.readyState}/${t.enabled ? 'enabled' : 'disabled'}/${t.muted ? 'muted' : 'unmuted'}`).join(', ') || '-'}
              </div>
              {trace && (
                <>
                  <div>
                    {`getUserMedia=${ms(trace.getUserMediaCalledAt, base)}、start()=${ms(trace.recorder.startCalledAt, base)}、`
                      + `stop()=${trace.recorder.stopCalls.map(c => `${ms(c.at, base)}(${c.by})`).join(', ') || '-'}、onstop=${ms(trace.recorder.onstopAt, base)}`}
                  </div>
                  <div>
                    {`AudioContext：作成=${ms(trace.audioContext.createdAt, base)}、connect=${ms(trace.audioContext.sourceConnectedAt, base)}、`
                      + `disconnect=${trace.audioContext.disconnectSkipped ? 'しない' : ms(trace.audioContext.disconnectedAt, base)}、`
                      + `close()=${ms(trace.audioContext.closeCalledAt, base)}、完了=${ms(trace.audioContext.closeResolvedAt, base)}`}
                  </div>
                  <div>
                    {`音量：最初=${ms(trace.level.firstSampleAt, base)}、最初の 0 でない値=${ms(trace.level.firstNonZeroAt, base)}、`
                      + `RMS 最大=${session.level.rmsMax.toFixed(3)}、回数=${session.level.samples}`}
                  </div>
                  <div>
                    音声認識：{trace.recognition.events.map(e => `${e.type}${e.error ? `(${e.error})` : ''}${e.chars !== undefined ? `(${e.chars}字)` : ''}@${ms(e.at, base)}`).join(' ') || '-'}
                  </div>
                  {trace.recognitionEndWait && (
                    <div>
                      {`recogfirst：待ち始め=${trace.recognitionEndWait.noRecognition ? '音声認識なし（待たない）' : ms(trace.recognitionEndWait.waitStartedAt, base)}、`
                        + `end=${ms(trace.recognitionEndWait.endAt, base)}、`
                        + `1.5 秒の見切り=${trace.recognitionEndWait.recognitionEndTimedOut ? `した@${ms(trace.recognitionEndWait.timedOutAt, base)}` : 'しない'}、`
                        + `見切りの後の end=${ms(trace.recognitionEndWait.lateEndAt, base)}、`
                        + `500ms の待ちの終わり=${ms(trace.recognitionEndWait.delayEndedAt, base)}、`
                        + `中断=${ms(trace.recognitionEndWait.cancelledAt, base)}、`
                        + `見張りの見切り=${session.recorder.stopTimedOut ? 'した' : 'しない'}`}
                    </div>
                  )}
                  {trace.recogEarly && (
                    <div>{`recogearly：録音の成立の前に止めた=${ms(trace.recogEarly.stoppedBeforeRecordingAt, base)}`}</div>
                  )}
                  {trace.trackEvents.length > 0 && (
                    <div>track の出来事：{trace.trackEvents.map(e => `${e.type}#${e.track}@${ms(e.at, base)}`).join(' ')}</div>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ol>
      {diagnostics.experiment?.recognitionOnce && (
        <RecognitionOnceView once={diagnostics.experiment.recognitionOnce} />
      )}
      {diagnostics.experiment && diagnostics.experiment.pageEvents.length > 0 && (
        <p style={{ margin: '4px 0 0' }}>
          ページの出来事：{diagnostics.experiment.pageEvents.map(e => `${e.type}(${e.visibilityState}${e.persisted !== undefined ? `,persisted=${e.persisted}` : ''})`).join(' ')}
        </p>
      )}
    </div>
  )
}

// legacymute の読み上げの記録（直近の 5 件）
function TtsPlaysView({ plays }: { plays: LegacyTtsPlay[] }) {
  const shown = plays.slice(-SHOWN_TTS_PLAYS)
  return (
    <div data-testid="experiment-tts-plays">
      <p style={{ margin: '8px 0 4px' }}>読み上げ</p>
      {shown.length === 0 && <p>読み上げの記録はありません</p>}
      <ol style={{ margin: 0, paddingLeft: '20px' }}>
        {shown.map((p, i) => (
          <li key={i}>
            {`直前の録音の番号=${p.afterRecordingNo ?? '-'}、再生の前の track=${p.trackStatesBeforePlay.join(', ') || '-'}、`
              + `play()=${p.playResult ?? '結果なし'}、onended=${p.ended ? '来た' : '来ていない'}、onerror=${p.error ? '来た' : '来ていない'}`}
          </li>
        ))}
      </ol>
    </div>
  )
}

// recogonce の記録。部品は画面で1つなので、セッションごとではなく画面の単位で出す。
// 出来事は「出来事#結び付けたセッション/そのときの有効なセッション」で、2つが一致しないものに印（不一致）を付ける
function RecognitionOnceView({ once }: { once: ExperimentRecognitionOnce }) {
  const mismatched = once.events.filter(e => e.boundSessionId !== e.activeSessionId)
  return (
    <p style={{ margin: '4px 0 0' }}>
      {`recogonce：部品を作った回数=${once.createdCount}、手放した=${once.disposedAt === null ? 'まだ' : 'した'}、一致しない出来事=${mismatched.length}件`}
      <br />
      {once.events.map(e => `${e.type}#${e.boundSessionId}/${e.activeSessionId ?? '-'}${e.boundSessionId !== e.activeSessionId ? '（不一致）' : ''}`).join(' ') || '-'}
      <br />
      {`前の実行の end を待たずに飛ばした録音=${once.skippedPendingEnd.length}件`}
      {once.skippedPendingEnd.length > 0 && `（${once.skippedPendingEnd.map(k => `セッション ${k.sessionId}@${ms(k.at, 0)}`).join('、')}。時刻は、ほかの行と違い、ページを開いてからの時間。recogonce の判定に使わない）`}
    </p>
  )
}

// recogonly の記録（直近の 5 発話と、直近の 5 件の読み上げ。「コピー」の JSON にはすべて入る）
function RecogOnlyView({ snapshot }: { snapshot: Extract<ExperimentSnapshot, { kind: 'recogonly' }> }) {
  const { recordings, ttsPlays, recognitionStarts } = snapshot.diagnostics
  const shown = recordings.slice(-SHOWN_SESSIONS)
  const shownPlays = ttsPlays.slice(-SHOWN_TTS_PLAYS)
  return (
    <div data-testid="experiment-snapshot">
      <p style={{ margin: '8px 0 4px' }}>{snapshot.takenAt}（recogonly）</p>
      {shown.length === 0 && <p>発話の記録はありません</p>}
      <ol style={{ margin: 0, paddingLeft: '20px' }}>
        {shown.map(r => {
          const errors = r.events.filter(e => e.type === 'error').map(e => e.error ?? '-')
          return (
            <li key={r.recordingNo}>
              {`#${r.recordingNo}、言語=${r.lang}、終了=${r.finishReason ?? '-'}、自動の始め直し=${r.autoRestarts}、`
                + `stop→end=${r.stopToEndMs === null ? '-' : `${Math.round(r.stopToEndMs)}ms`}、時間切れ=${r.endTimeoutFired ? 'した' : 'しない'}、`
                + `文字数=${r.finalTextLength ?? '-'}、transcriptSent=${r.transcriptSent}、結果=${r.interpretResult ?? '-'}、`
                + `エラー=${[...errors, ...(r.startError ? [`start:${r.startError}`] : []), ...(r.stopError ? [`stop:${r.stopError}`] : []), ...(r.constructorError ? [`constructor:${r.constructorError}`] : []), ...r.restartErrors.map(e => `restart:${e}`)].join(', ') || 'なし'}`}
            </li>
          )
        })}
      </ol>
      <p style={{ margin: '4px 0 0' }}>{`start() の回数：操作の中=${recognitionStarts.gesture}、自動の始め直し=${recognitionStarts.restart}`}</p>
      <div data-testid="experiment-tts-plays">
        <p style={{ margin: '8px 0 4px' }}>読み上げ</p>
        {shownPlays.length === 0 && <p>読み上げの記録はありません</p>}
        <ol style={{ margin: 0, paddingLeft: '20px' }}>
          {shownPlays.map((p, i) => (
            <li key={i}>
              {`直前の発話の番号=${p.afterRecordingNo ?? '-'}、play()=${p.playResult ?? '結果なし'}、`
                + `onended=${p.ended ? '来た' : '来ていない'}、onerror=${p.error ? '来た' : '来ていない'}`}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
