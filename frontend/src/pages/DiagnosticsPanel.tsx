import { useState } from 'react'
import type { AudioDiagnostics } from '../hooks/useKeptAudioSession'

// 通訳の画面の診断の表示（docs/testing.md の「診断の表示（?diag）」）。URL に diag があるときだけ描画する。
// 表示は「更新」を押したときだけ、そのときの診断の情報（スナップショット）を読んで変える。
// 定期的な読み取り、新しい timer、出来事ごとの React の状態の更新はしない（診断が、調べている動きを変えないため）。
// 開発用の表示なので、文言は日本語だけにしている

const SHOWN_SESSIONS = 5

export interface DiagnosticsSnapshot {
  kind: 'audioSession'
  takenAt: string
  diagnostics: AudioDiagnostics
}

interface DiagnosticsPanelProps {
  // 録音中（starting、recording、stopping）は true。ボタンを押せないようにする
  busy: boolean
  // 押したときにその場で最新の診断の情報を読む
  read: () => DiagnosticsSnapshot
}

export default function DiagnosticsPanel({ busy, read }: DiagnosticsPanelProps) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [fallbackJson, setFallbackJson] = useState<string | null>(null)

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
    <section className="diagnostics-panel" aria-label="実験の診断" style={{ margin: '16px', padding: '12px', border: '1px dashed #999', fontSize: '12px', textAlign: 'left' }}>
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

function SnapshotView({ snapshot }: { snapshot: DiagnosticsSnapshot }) {
  const sessions = snapshot.diagnostics.sessions.slice(-SHOWN_SESSIONS)
  return (
    <div data-testid="diagnostics-snapshot">
      <p style={{ margin: '8px 0 4px' }}>{snapshot.takenAt}</p>
      {sessions.length === 0 && <p>録音の記録はありません</p>}
      <ol style={{ margin: 0, paddingLeft: '20px' }}>
        {sessions.map(session => (
          <li key={session.id} style={{ marginBottom: '6px' }}>
            <div>セッション {session.id}：止めた理由={session.stopReason ?? '-'}、mimeType={session.recorder.mimeType ?? '-'}</div>
            <div>{`bytes=${session.recorder.bytes}`}</div>
            <div>
              track={session.tracks.map(t => `${t.readyState}/${t.enabled ? 'enabled' : 'disabled'}/${t.muted ? 'muted' : 'unmuted'}`).join(', ') || '-'}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
