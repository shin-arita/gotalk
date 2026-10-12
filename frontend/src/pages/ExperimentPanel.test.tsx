import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import ExperimentPanel from './ExperimentPanel'
import type { ExperimentSnapshot } from './ExperimentPanel'
import { DEFAULT_EXPERIMENT_CONFIG, readExperimentConfig } from '../experiments'
import { newExperimentDiagnostics, newExperimentSessionTrace } from '../hooks/experimentTrace'
import type { AudioSessionDiagnostics } from '../hooks/useAudioSession'

// 切り分けの実験の診断の表示の部品（docs/testing.md の「実験のスイッチ」）

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

async function refresh() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
  return screen.getByTestId('experiment-snapshot')
}

describe('ExperimentPanel', () => {
  it('renders nothing without exp', () => {
    const { container } = render(<ExperimentPanel config={DEFAULT_EXPERIMENT_CONFIG} busy={false} read={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a session without the experiment trace', async () => {
    const config = readExperimentConfig('?exp=')
    const snapshot: ExperimentSnapshot = {
      kind: 'audioSession',
      takenAt: 't',
      effective: [],
      diagnostics: {
        sessions: [sessionDiag(1, { tracks: [{ readyState: 'ended', enabled: false, muted: true }] })],
        events: [],
      },
    }
    render(<ExperimentPanel config={config} busy={false} read={() => snapshot} />)
    const view = await refresh()
    expect(view).toHaveTextContent('セッション 1：止めた理由=-、mimeType=-')
    expect(view).toHaveTextContent('ondataavailable=-、Blob=-、bytes=0')
    expect(view).toHaveTextContent('track=ended/disabled/muted')
    expect(view).not.toHaveTextContent('AudioContext')
  })

  it('shows the trace of a session with skipped disconnect, unread tracks, track and page events', async () => {
    const config = readExperimentConfig('?exp=trace,notrackread,nodisconnect')
    const experiment = newExperimentDiagnostics(config)
    const trace = newExperimentSessionTrace(1, config)
    trace.clock.performanceNow = 1000
    trace.getUserMediaCalledAt = 1001
    trace.audioContext.disconnectSkipped = true
    trace.recorder.data.push({ at: 1500, size: 7, activeSession: true })
    trace.recorder.stopCalls.push({ at: 1400, by: 'user' })
    trace.recorder.blobSize = 7
    trace.recognition.events.push({ type: 'error', at: 1100, error: 'no-speech' }, { type: 'result', at: 1200, chars: 3 })
    trace.trackEvents.push({ type: 'mute', at: 1300, track: 0 })
    experiment.sessions.push(trace)
    experiment.pageEvents.push({ type: 'pagehide', at: 1600, visibilityState: 'hidden', persisted: true }, { type: 'visibilitychange', at: 1700, visibilityState: 'visible' })
    const snapshot: ExperimentSnapshot = {
      kind: 'audioSession',
      takenAt: 't',
      effective: config.effective,
      diagnostics: { sessions: [sessionDiag(1, { stopReason: 'user' })], events: [], experiment },
    }
    render(<ExperimentPanel config={config} busy={false} read={() => snapshot} />)
    const view = await refresh()
    expect(view).toHaveTextContent('ondataavailable=1回 [7]、Blob=7')
    expect(view).toHaveTextContent('track=読んでいない（notrackread）')
    expect(view).toHaveTextContent('getUserMedia=1ms')
    expect(view).toHaveTextContent('stop()=400ms(user)')
    expect(view).toHaveTextContent('disconnect=しない')
    expect(view).toHaveTextContent('音声認識：error(no-speech)@100ms result(3字)@200ms')
    expect(view).toHaveTextContent('track の出来事：mute#0@300ms')
    expect(view).toHaveTextContent('ページの出来事：pagehide(hidden,persisted=true) visibilitychange(visible)')
  })

  it('shows the legacy recordings and an empty legacy record', async () => {
    const config = readExperimentConfig('?exp=legacy')
    let recordings: Extract<ExperimentSnapshot, { kind: 'legacy' }>['recordings'] = []
    const read = (): ExperimentSnapshot => ({ kind: 'legacy', takenAt: 't', effective: ['legacy'], config, recordings })
    render(<ExperimentPanel config={config} busy={false} read={read} />)
    expect(await refresh()).toHaveTextContent('録音の記録はありません')
    recordings = [
      { startCalledAt: 10, stopCalledAt: 1010, dataSizes: [5], blobSize: 5, blobType: 'audio/mp4' },
      { startCalledAt: 10, stopCalledAt: null, dataSizes: [], blobSize: null, blobType: null },
    ]
    const view = await refresh()
    expect(view).toHaveTextContent('start→stop=1000ms、ondataavailable=1回 [5]、Blob=5（type=audio/mp4）')
    expect(view).toHaveTextContent('start→stop=-、ondataavailable=0回 []、Blob=-（type=-）')
  })

  it('shows only the latest five sessions', async () => {
    const config = readExperimentConfig('?exp=')
    const sessions = [1, 2, 3, 4, 5, 6, 7].map(id => sessionDiag(id))
    render(<ExperimentPanel config={config} busy={false} read={() => ({ kind: 'audioSession', takenAt: 't', effective: [], diagnostics: { sessions, events: [] } })} />)
    const view = await refresh()
    expect(view).not.toHaveTextContent('セッション 2：')
    expect(view).toHaveTextContent('セッション 3：')
    expect(view).toHaveTextContent('セッション 7：')
  })

  it('falls back to the textarea when there is no clipboard', async () => {
    const config = readExperimentConfig('?exp=')
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<ExperimentPanel config={config} busy={false} read={() => ({ kind: 'audioSession', takenAt: 't', effective: [], diagnostics: { sessions: [], events: [] } })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'コピー' })) })
    const textarea = screen.getByRole('textbox', { name: '診断の JSON' }) as HTMLTextAreaElement
    expect(JSON.parse(textarea.value).takenAt).toBe('t')
    // 選びやすいように、フォーカスで全体を選ぶ
    const select = vi.spyOn(textarea, 'select')
    fireEvent.focus(textarea)
    expect(select).toHaveBeenCalled()
  })
})
