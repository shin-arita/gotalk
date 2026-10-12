import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import ExperimentPanel from './ExperimentPanel'
import type { ExperimentSnapshot } from './ExperimentPanel'
import { readExperimentConfig } from '../experiments'
import { newExperimentDiagnostics, newExperimentSessionTrace } from '../hooks/experimentTrace'
import type { AudioSessionDiagnostics } from '../hooks/useAudioSession'

// 2回目の切り分けの実験（recogfirst、recogdelay、recogearly、recogonce）の診断の表示（docs/testing.md）

afterEach(() => {
  cleanup()
})

function sessionDiag(id: number, stopTimedOut = false): AudioSessionDiagnostics {
  return {
    id,
    stopReason: 'user',
    getUserMedia: { startedAt: null, succeededAt: null, errorName: null },
    tracks: [],
    recorder: {
      state: null, mimeType: null, startedAt: null, stoppedAt: null, durationMs: null, stopRequestedAt: null, stopLatencyMs: null,
      stopTimedOut, stopWaitedMs: null, bytes: 0, errorName: null,
    },
    audioContext: { state: null },
    level: { rms: 0, rmsMax: 0, peak: 0, samples: 0 },
    recognition: { hadResult: false, chars: 0 },
  }
}

async function show(exp: string, fill: (experiment: ReturnType<typeof newExperimentDiagnostics>, config: ReturnType<typeof readExperimentConfig>) => AudioSessionDiagnostics[]) {
  const config = readExperimentConfig(exp)
  const experiment = newExperimentDiagnostics(config)
  const sessions = fill(experiment, config)
  const snapshot: ExperimentSnapshot = { kind: 'audioSession', takenAt: 't', effective: config.effective, diagnostics: { sessions, events: [], experiment } }
  render(<ExperimentPanel config={config} busy={false} read={() => snapshot} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })) })
  return screen.getByTestId('experiment-snapshot')
}

describe('ExperimentPanel: the second experiment', () => {
  it('shows the recogfirst wait that got the end, with recogdelay and recogabort', async () => {
    const view = await show('?exp=recogfirst,recogdelay,recogabort', (experiment, config) => {
      const trace = newExperimentSessionTrace(1, config)
      trace.clock.performanceNow = 1000
      trace.recognition.events.push({ type: 'abort_call', at: 1100 }, { type: 'end', at: 1200 })
      Object.assign(trace.recognitionEndWait!, { waitStartedAt: 1100, endAt: 1200, delayEndedAt: 1700 })
      experiment.sessions.push(trace)
      return [sessionDiag(1)]
    })
    expect(view).toHaveTextContent('音声認識：abort_call@100ms end@200ms')
    expect(view).toHaveTextContent('recogfirst：待ち始め=100ms、end=200ms、1.5 秒の見切り=しない、見切りの後の end=-、500ms の待ちの終わり=700ms、中断=-、見張りの見切り=しない')
    expect(view).not.toHaveTextContent('recogearly')
    expect(view).not.toHaveTextContent('recogonce')
  })

  it('shows the recogfirst timeout, the late end, the cancel, the watchdog and no recognition separately', async () => {
    const view = await show('?exp=recogfirst', (experiment, config) => {
      const timedOut = newExperimentSessionTrace(1, config)
      timedOut.clock.performanceNow = 0
      Object.assign(timedOut.recognitionEndWait!, { waitStartedAt: 10, recognitionEndTimedOut: true, timedOutAt: 1510, lateEndAt: 2000, cancelledAt: null })
      const none = newExperimentSessionTrace(2, config)
      none.clock.performanceNow = 0
      none.recognitionEndWait!.noRecognition = true
      none.recognitionEndWait!.cancelledAt = 30
      experiment.sessions.push(timedOut, none)
      return [sessionDiag(1), sessionDiag(2, true)]
    })
    expect(view).toHaveTextContent('1.5 秒の見切り=した@1510ms、見切りの後の end=2000ms')
    expect(view).toHaveTextContent('recogfirst：待ち始め=音声認識なし（待たない）')
    expect(view).toHaveTextContent('中断=30ms、見張りの見切り=した')
  })

  it('shows when recogearly stopped the recognition before the recording', async () => {
    const view = await show('?exp=recogearly', (experiment, config) => {
      const trace = newExperimentSessionTrace(1, config)
      trace.clock.performanceNow = 100
      trace.recogEarly!.stoppedBeforeRecordingAt = 150
      experiment.sessions.push(trace, Object.assign(newExperimentSessionTrace(2, config), { clock: { dateNow: 0, performanceNow: 0 } }))
      return [sessionDiag(1), sessionDiag(2)]
    })
    expect(view).toHaveTextContent('recogearly：録音の成立の前に止めた=50ms')
    expect(view).toHaveTextContent('recogearly：録音の成立の前に止めた=-')
    expect(view).not.toHaveTextContent('recogfirst：')
  })

  it('shows the recogonce count and the events that do not match the active session', async () => {
    const view = await show('?exp=recogonce', (experiment) => {
      experiment.recognitionOnce!.createdCount = 1
      experiment.recognitionOnce!.events.push(
        { type: 'start_call', at: 1, boundSessionId: 1, activeSessionId: 1 },
        { type: 'end', at: 2, boundSessionId: 1, activeSessionId: null },
        { type: 'result', at: 3, boundSessionId: 1, activeSessionId: 2 },
      )
      return []
    })
    expect(view).toHaveTextContent('recogonce：部品を作った回数=1、手放した=まだ、一致しない出来事=2件')
    expect(view).toHaveTextContent('start_call#1/1 end#1/-（不一致） result#1/2（不一致）')
  })

  it('shows the recogonce record without events after the release', async () => {
    const view = await show('?exp=recogonce', (experiment) => {
      experiment.recognitionOnce!.disposedAt = 5
      return []
    })
    expect(view).toHaveTextContent('recogonce：部品を作った回数=0、手放した=した、一致しない出来事=0件')
  })
})
