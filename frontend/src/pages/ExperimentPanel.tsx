import { useState } from 'react'
import type { ExperimentConfig } from '../experiments'
import type { AudioDiagnostics } from '../hooks/useAudioSession'

// 切り分けの実験の診断の表示（docs/testing.md の「実験のスイッチ」）。URL に exp があるときだけ描画する。
// 表示は「更新」を押したときだけ、そのときの診断の情報（スナップショット）を読んで変える。
// 定期的な読み取り、新しい timer、出来事ごとの React の状態の更新はしない（診断が、調べている動きを変えないため）。
// 開発用の表示なので、文言は日本語だけにしている。原因が分かったら、このファイルは外す

const SHOWN_SESSIONS = 5

// legacy（PR #26 の前の通訳の画面）の最小限の記録。録音ごとに1つ
export interface LegacyRecording {
  mimeType: string | null
  // performance.now()
  startCalledAt: number | null
  stopCalledAt: number | null
  // ondataavailable の回ごとの大きさ
  dataSizes: number[]
  // onstop で作った Blob の大きさ（利用者の停止のときだけ）
  blobSize: number | null
}

export type ExperimentSnapshot =
  | { kind: 'audioSession'; takenAt: string; effective: string[]; diagnostics: AudioDiagnostics }
  | { kind: 'legacy'; takenAt: string; effective: string[]; config: Pick<ExperimentConfig, 'raw' | 'requested' | 'ignored' | 'inactive' | 'effective'>; recordings: LegacyRecording[] }

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
  if (snapshot.kind === 'legacy') {
    const recordings = snapshot.recordings.slice(-SHOWN_SESSIONS)
    return (
      <div data-testid="experiment-snapshot">
        <p style={{ margin: '8px 0 4px' }}>{snapshot.takenAt}（legacy）</p>
        {recordings.length === 0 && <p>録音の記録はありません</p>}
        <ol style={{ margin: 0, paddingLeft: '20px' }}>
          {recordings.map((r, i) => (
            <li key={i}>
              mimeType={r.mimeType ?? '-'}、start→stop={r.startCalledAt !== null && r.stopCalledAt !== null ? `${Math.round(r.stopCalledAt - r.startCalledAt)}ms` : '-'}、
              ondataavailable={r.dataSizes.length}回 [{r.dataSizes.join(', ')}]、Blob={r.blobSize ?? '-'}
            </li>
          ))}
        </ol>
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
                ondataavailable={trace ? `${trace.recorder.data.length}回 [${trace.recorder.data.map(d => d.size).join(', ')}]` : '-'}、
                Blob={trace?.recorder.blobSize ?? '-'}、bytes={session.recorder.bytes}
              </div>
              <div>
                track={trace && !trace.tracksRead ? '読んでいない（notrackread）' : session.tracks.map(t => `${t.readyState}/${t.enabled ? 'enabled' : 'disabled'}/${t.muted ? 'muted' : 'unmuted'}`).join(', ') || '-'}
              </div>
              {trace && (
                <>
                  <div>
                    getUserMedia={ms(trace.getUserMediaCalledAt, base)}、start()={ms(trace.recorder.startCalledAt, base)}、
                    stop()={trace.recorder.stopCalls.map(c => `${ms(c.at, base)}(${c.by})`).join(', ') || '-'}、onstop={ms(trace.recorder.onstopAt, base)}
                  </div>
                  <div>
                    AudioContext：作成={ms(trace.audioContext.createdAt, base)}、connect={ms(trace.audioContext.sourceConnectedAt, base)}、
                    disconnect={trace.audioContext.disconnectSkipped ? 'しない' : ms(trace.audioContext.disconnectedAt, base)}、
                    close()={ms(trace.audioContext.closeCalledAt, base)}、完了={ms(trace.audioContext.closeResolvedAt, base)}
                  </div>
                  <div>
                    音量：最初={ms(trace.level.firstSampleAt, base)}、最初の 0 でない値={ms(trace.level.firstNonZeroAt, base)}、
                    RMS 最大={session.level.rmsMax.toFixed(3)}、回数={session.level.samples}
                  </div>
                  <div>
                    音声認識：{trace.recognition.events.map(e => `${e.type}${e.error ? `(${e.error})` : ''}${e.chars !== undefined ? `(${e.chars}字)` : ''}@${ms(e.at, base)}`).join(' ') || '-'}
                  </div>
                  {trace.trackEvents.length > 0 && (
                    <div>track の出来事：{trace.trackEvents.map(e => `${e.type}#${e.track}@${ms(e.at, base)}`).join(' ')}</div>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ol>
      {diagnostics.experiment && diagnostics.experiment.pageEvents.length > 0 && (
        <p style={{ margin: '4px 0 0' }}>
          ページの出来事：{diagnostics.experiment.pageEvents.map(e => `${e.type}(${e.visibilityState}${e.persisted !== undefined ? `,persisted=${e.persisted}` : ''})`).join(' ')}
        </p>
      )}
    </div>
  )
}
