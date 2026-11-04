import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import DiagnosticsPanel from './DiagnosticsPanel'
import type { DiagnosticsSnapshot } from './DiagnosticsPanel'
import type { AudioSessionDiagnostics } from '../hooks/useKeptAudioSession'

// 通訳の画面の診断の表示の部品（docs/testing.md の「診断の表示（?diag）」）

afterEach(() => {
  cleanup()
  delete (navigator as unknown as Record<string, unknown>).clipboard
})

function sessionDiag(id: number, overrides: Partial<AudioSessionDiagnostics> = {}): AudioSessionDiagnostics {
  return {
    id,
    stopReason: null,
    getUserMedia: { startedAt: null, succeededAt: null, errorName: null },
    tracks: [],
    recorder: {
      state: null, mimeType: null, startedAt: null, stoppedAt: null, durationMs: null, stopRequestedAt: null, stopLatencyMs: null,
      stopTimedOut: false, stopWaitedMs: null, bytes: 0, errorName: null,
    },
    audioContext: { state: null },
    level: { rms: 0, rmsMax: 0, peak: 0, samples: 0 },
    recognition: { hadResult: false, chars: 0 },
    ...overrides,
  }
}

function snapshotOf(sessions: AudioSessionDiagnostics[]): DiagnosticsSnapshot {
  return { kind: 'audioSession', takenAt: 't', diagnostics: { sessions, events: [] } }
}

async function refresh() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
  return screen.getByTestId('diagnostics-snapshot')
}

describe('DiagnosticsPanel', () => {
  it('shows nothing of the snapshot until 更新 is pressed, and an empty record', async () => {
    render(<DiagnosticsPanel busy={false} read={() => snapshotOf([])} />)
    expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull()
    expect(await refresh()).toHaveTextContent('録音の記録はありません')
  })

  it('shows the stop reason, the mimeType, the bytes and the tracks of a session', async () => {
    const snapshot = snapshotOf([
      sessionDiag(1),
      sessionDiag(2, {
        stopReason: 'user',
        tracks: [{ readyState: 'ended', enabled: false, muted: true }],
        recorder: { ...sessionDiag(2).recorder, mimeType: 'audio/mp4', bytes: 1234 },
      }),
    ])
    render(<DiagnosticsPanel busy={false} read={() => snapshot} />)
    const view = await refresh()
    expect(view).toHaveTextContent('セッション 1：止めた理由=-、mimeType=-')
    expect(view).toHaveTextContent('bytes=0')
    expect(view).toHaveTextContent('track=-')
    expect(view).toHaveTextContent('セッション 2：止めた理由=user、mimeType=audio/mp4')
    expect(view).toHaveTextContent('bytes=1234')
    expect(view).toHaveTextContent('track=ended/disabled/muted')
    // 実験だけの表示（trace の値）は出さない
    expect(view).not.toHaveTextContent('ondataavailable')
    expect(view).not.toHaveTextContent('AudioContext')
    expect(screen.queryByText(/実験：/)).toBeNull()
  })

  it('shows only the latest five sessions', async () => {
    const sessions = [1, 2, 3, 4, 5, 6, 7].map(id => sessionDiag(id))
    render(<DiagnosticsPanel busy={false} read={() => snapshotOf(sessions)} />)
    const view = await refresh()
    expect(view).not.toHaveTextContent('セッション 2：')
    expect(view).toHaveTextContent('セッション 3：')
    expect(view).toHaveTextContent('セッション 7：')
  })

  it('falls back to the textarea when there is no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<DiagnosticsPanel busy={false} read={() => snapshotOf([])} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const textarea = screen.getByRole('textbox', { name: '診断の JSON' }) as HTMLTextAreaElement
    expect(JSON.parse(textarea.value).takenAt).toBe('t')
    expect(screen.getByRole('status')).toHaveTextContent('コピーできませんでした。下の JSON を選んで写してください')
    // 選びやすいように、フォーカスで全体を選ぶ
    const select = vi.spyOn(textarea, 'select')
    fireEvent.focus(textarea)
    expect(select).toHaveBeenCalled()
  })

  it('disables the buttons while busy', () => {
    render(<DiagnosticsPanel busy read={() => snapshotOf([])} />)
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'コピー' })).toBeDisabled()
  })
})
