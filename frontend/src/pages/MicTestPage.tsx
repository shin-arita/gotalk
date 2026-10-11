import { useState, useEffect, useRef } from 'react'

// 開発用のマイクの確認のページ（#mic-test）。
// 国旗を押すたびに出るブラウザのマイクのお知らせが、getUserMedia の開き直しと
// 音声認識の始め直しのどちらで出るのかを、実機で確かめるために使います。
// 録音した音声と音声認識の結果は、送信も保存もせず、ページの中に表示するだけです。
// 直前の1件の録音だけは、音が取れているかを確かめるため、ページの中で再生できるようにメモリに持ちます。
//
// 通訳の画面との違い：音声認識の continuous と interimResults は同じですが、lang は ja-JP に
// 固定しています（通訳の画面は押した国旗の言語）。また、通訳の画面にある、録音の間の
// 音声認識の自動の始め直し（onend での start()）と、AudioContext（音量の取得）はありません。
// 実機の結果を読むときは、これらの違いに気を付けてください。

type TestId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S7'

const TESTS: { id: TestId; description: string }[] = [
  { id: 'S1', description: '開始のたびに getUserMedia でマイクを開いて録音し、停止で track を stop() で閉じる（今の通訳の画面のマイクの部分）' },
  { id: 'S2', description: 'マイクは最初の1回だけ開いて閉じない。開始で track.enabled = true にして録音し、停止で録音を止めて track.enabled = false にする。音声認識は使わない' },
  { id: 'S3', description: 'マイクは最初の1回だけ開いて閉じない（track.enabled は true のまま）。開始のたびに音声認識を新しく作って start() し、停止で stop() する。録音はしない' },
  { id: 'S4', description: 'マイク（getUserMedia）は開かない。開始のたびに音声認識を新しく作って start() し、停止で stop() する' },
  { id: 'S5', description: 'マイクは最初の1回だけ開いて閉じない。開始で track.enabled = true にして録音と音声認識を始め、停止で両方を止めて track.enabled = false にする' },
  { id: 'S7', description: 'マイクは最初の1回だけ開いて閉じない。track は常に enabled = true のまま。開始のたびに録音を始め、停止で止める。音声認識は使わない' },
]

const RECOGNITION_TESTS: TestId[] = ['S3', 'S4', 'S5']

// 今の通訳の画面と同じ選び方
function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

interface RecognitionResultEvent {
  readonly results: { readonly length: number; readonly [i: number]: { readonly [j: number]: { readonly transcript: string } } }
}

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onstart: (() => void) | null
  onaudiostart: (() => void) | null
  onaudioend: (() => void) | null
  onsoundstart: (() => void) | null
  onsoundend: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onnomatch: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onresult: ((event: RecognitionResultEvent) => void) | null
  start(): void
  stop(): void
}

type RecognitionCtor = new () => Recognition

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// 直前の録音。Blob は object URL を通してメモリにだけ持つ
interface LastRecording {
  test: TestId
  count: number
  bytes: number
  // 録音の開始から停止までの秒数。onstart のイベントが来なかった場合は分からない
  seconds: number | null
  url: string
}

function recordingLabel(r: LastRecording): string {
  const length = r.seconds === null ? '' : `、約${r.seconds.toFixed(1)}秒`
  return `${r.test} ${r.count}回目の録音、${r.bytes}バイト${length}`
}

function formatTime(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : 'unknown'
}

const sectionStyle = { marginBottom: '24px' }
const logBoxStyle = {
  height: '320px', overflowY: 'auto' as const, border: '1px solid #ccc', padding: '8px',
  fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap' as const,
}

export default function MicTestPage() {
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState<TestId | null>(null)
  const [busy, setBusy] = useState(false)
  const [copyFallback, setCopyFallback] = useState(false)
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null)

  // 開いたままのマイクと、それを開いたテスト
  const streamRef = useRef<MediaStream | null>(null)
  const streamOwnerRef = useRef<TestId | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const [lastRecording, setLastRecording] = useState<LastRecording | null>(null)
  const lastRecordingRef = useRef<LastRecording | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 録音を始めるときと、録音を捨てるたびに増やす。止めた後に遅れて来る onstop のうち、
  // 古い録音のものや、捨てた後のものを持たないために使う
  const recordingTokenRef = useRef(0)
  // テストごとの開始の回数（track の ended、mute、unmute がどの開始の後に起きたかをログに出すため）
  const startCountsRef = useRef<Record<TestId, number>>({ S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S7: 0 })
  // すべて閉じるたびに増やし、閉じる前に始めた getUserMedia の結果を捨てるのに使う
  const generationRef = useRef(0)

  const addLog = (msg: string) =>
    setLog(prev => [`${formatTime(new Date())} ${msg}`, ...prev])

  const logPermission = async (when: string) => {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
      addLog(`permissions microphone=${status.state}（${when}）`)
    } catch {
      addLog(`permissions microphone=unsupported（${when}）`)
    }
  }

  const logTracks = (when: string) => {
    const stream = streamRef.current
    if (!stream) {
      addLog(`track なし（${when}）`)
      return
    }
    stream.getTracks().forEach((t, i) => {
      addLog(`track[${i}] readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}（${when}）`)
    })
  }

  const setTracksEnabled = (enabled: boolean) => {
    streamRef.current?.getTracks().forEach(t => { t.enabled = enabled })
  }

  const openStream = async (test: TestId, reopen = false): Promise<MediaStream | null> => {
    const generation = generationRef.current
    addLog(`getUserMedia 開始（${test}${reopen ? '、開き直し' : ''}）`)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (generation !== generationRef.current) {
        // 待っている間に閉じられた
        stream.getTracks().forEach(t => t.stop())
        addLog(`getUserMedia 成功したが、閉じた後のため track を stop()（${test}）`)
        return null
      }
      addLog(`getUserMedia 成功（${test}）`)
      stream.getTracks().forEach((t, i) => {
        // mute は、track が live のままでも音が届いていないときに起きる
        for (const type of ['ended', 'mute', 'unmute']) {
          t.addEventListener(type, () =>
            addLog(`track[${i}] ${type}（${test} ${startCountsRef.current[test]}回目の開始の後）`))
        }
      })
      streamRef.current = stream
      streamOwnerRef.current = test
      return stream
    } catch (e) {
      addLog(`getUserMedia 失敗 name=${errorName(e)}（${test}）`)
      return null
    }
  }

  // 同じテストで開いたマイクがあり、track がすべて動いていればそれを使い、なければ開く。
  // ブラウザや OS が track を終わらせていた場合は、閉じてから開き直す
  const ensureStream = async (test: TestId): Promise<MediaStream | null> => {
    const stream = streamRef.current
    if (stream && streamOwnerRef.current === test) {
      const tracks = stream.getTracks()
      if (tracks.length > 0 && tracks.every(t => t.readyState === 'live')) return stream
      const states = tracks.map(t => t.readyState).join(',') || 'なし'
      addLog(`track が終わっているため開き直す（readyState=${states}）（${test}）`)
      stopStream()
      return openStream(test, true)
    }
    return openStream(test)
  }

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    streamOwnerRef.current = null
  }

  // 直前の録音を捨てる。再生中なら止め、object URL を解放する
  const discardRecording = (reason: string) => {
    recordingTokenRef.current++
    const audio = audioRef.current
    audioRef.current = null
    audio?.pause()
    const recording = lastRecordingRef.current
    if (!recording) return
    lastRecordingRef.current = null
    URL.revokeObjectURL(recording.url)
    setLastRecording(null)
    addLog(`直前の録音を捨てる（${reason}）`)
  }

  const keepRecording = (recording: LastRecording) => {
    lastRecordingRef.current = recording
    setLastRecording(recording)
    addLog(`直前の録音を持つ（${recordingLabel(recording)}）`)
  }

  // 作成か start() が例外になった場合は、ログに出して false を返す
  const startRecorder = (stream: MediaStream, test: TestId): boolean => {
    discardRecording('次の録音の開始')
    const token = recordingTokenRef.current
    const count = startCountsRef.current[test]
    try {
      const mimeType = getSupportedMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      let bytes = 0
      const chunks: Blob[] = []
      let startedAt: number | null = null
      recorder.ondataavailable = (e: BlobEvent) => {
        bytes += e.data.size
        chunks.push(e.data)
      }
      recorder.onstart = (e: Event) => { startedAt = e.timeStamp }
      recorder.onstop = (e: Event) => {
        addLog(`MediaRecorder stop bytes=${bytes}`)
        // 次の録音を始めた後や、捨てた後に届いたものは持たない
        if (token !== recordingTokenRef.current) return
        const seconds = startedAt === null ? null : (e.timeStamp - startedAt) / 1000
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || undefined })
        let url: string
        try {
          url = URL.createObjectURL(blob)
        } catch (e) {
          addLog(`録音を持てませんでした name=${errorName(e)}`)
          return
        }
        keepRecording({ test, count, bytes, seconds, url })
      }
      recorder.start()
      recorderRef.current = recorder
      addLog(`MediaRecorder start mimeType=${recorder.mimeType || mimeType || '（既定）'}`)
      return true
    } catch (e) {
      addLog(`MediaRecorder 失敗 name=${errorName(e)}`)
      return false
    }
  }

  const stopRecorder = () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder || recorder.state === 'inactive') return
    try {
      recorder.stop()
    } catch (e) {
      addLog(`MediaRecorder stop() 失敗 name=${errorName(e)}`)
    }
  }

  // 作成か start() が例外になった場合は、ログに出して false を返す
  const startRecognition = (Ctor: RecognitionCtor): boolean => {
    let recognition: Recognition
    try {
      recognition = new Ctor()
    } catch (e) {
      addLog(`音声認識の作成に失敗 name=${errorName(e)}`)
      return false
    }
    // continuous と interimResults は通訳の画面と同じ。lang は ja-JP に固定（通訳の画面は押した国旗の言語）。
    // 通訳の画面と違い、onend で自動で始め直さない
    recognition.lang = 'ja-JP'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => addLog('音声認識 onstart')
    recognition.onaudiostart = () => addLog('音声認識 onaudiostart')
    recognition.onaudioend = () => addLog('音声認識 onaudioend')
    // 音声認識が音や声を受け取ったかを確かめるため
    recognition.onsoundstart = () => addLog('音声認識 onsoundstart')
    recognition.onsoundend = () => addLog('音声認識 onsoundend')
    recognition.onspeechstart = () => addLog('音声認識 onspeechstart')
    recognition.onspeechend = () => addLog('音声認識 onspeechend')
    recognition.onnomatch = () => addLog('音声認識 onnomatch')
    recognition.onend = () => addLog('音声認識 onend')
    recognition.onerror = e => addLog(`音声認識 onerror error=${e.error ?? 'unknown'}`)
    recognition.onresult = e => {
      // 結果の文字列は表示せず、文字数だけを出す
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      addLog(`音声認識 onresult 文字数=${[...text].length}`)
    }
    try {
      recognition.start()
    } catch (e) {
      // 始められなかったので、stop() の対象にしない
      addLog(`音声認識 start() 失敗 name=${errorName(e)}`)
      return false
    }
    recognitionRef.current = recognition
    addLog('音声認識 start()')
    return true
  }

  const stopRecognition = () => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (!recognition) return
    try {
      recognition.stop()
      addLog('音声認識 stop()')
    } catch (e) {
      addLog(`音声認識 stop() 失敗 name=${errorName(e)}`)
    }
  }

  const closeAll = () => {
    generationRef.current++
    stopRecorder()
    stopRecognition()
    if (streamRef.current) {
      stopStream()
      addLog('すべての track を stop()')
    }
    setRunning(null)
  }

  const start = async (test: TestId) => {
    startCountsRef.current[test]++
    addLog(`${test} 開始（${startCountsRef.current[test]}回目）`)
    const RecognitionCtor = getRecognitionCtor()
    if (RECOGNITION_TESTS.includes(test) && !RecognitionCtor) {
      addLog('このブラウザは音声認識に対応していません')
      return
    }
    // 別のテストのマイクと音声認識は、すべて閉じてから始める
    if (running || (streamRef.current && streamOwnerRef.current !== test)) {
      addLog('前のテストを閉じます')
      closeAll()
    }
    // 切り替えのための closeAll の後の世代の番号。開くのを待っている間に pagehide などで
    // closeAll が呼ばれると変わる
    const generation = generationRef.current
    // この開始で録音を始めると変わる（startRecorder の最初の discardRecording で増えるため）
    const recordingToken = recordingTokenRef.current
    setBusy(true)
    try {
      let started: boolean
      try {
        started = await openResources(test, RecognitionCtor)
      } catch (e) {
        addLog(`${test} 開始で例外 name=${errorName(e)}`)
        started = false
      }
      if (!started && generation !== generationRef.current) {
        // 開始の失敗ではなく、閉じられたため。閉じる処理はもう済んでいるので、closeAll は呼ばない
        addLog(`${test} の開始をやめる（開始を待っている間に閉じられたため）`)
        return
      }
      if (!started) {
        // 途中まで開いたマイク、録音、音声認識を残さず、running も設定しない
        addLog(`${test} 開始に失敗したため、すべて閉じる`)
        // 失敗した開始で始めた録音は、closeAll で止めた後に届く onstop で持たないよう、先に無効にする。
        // この開始で録音を始めていなければ、ほかの録音の onstop を無効にしないよう、何もしない
        if (recordingTokenRef.current !== recordingToken) recordingTokenRef.current++
        closeAll()
        logTracks(`${test} 開始に失敗`)
        return
      }
      setRunning(test)
      logTracks(`${test} 開始`)
      void logPermission(`${test} 開始`)
    } finally {
      setBusy(false)
    }
  }

  // テストごとにマイク、録音、音声認識を開く。どれかに失敗したら false を返す
  const openResources = async (test: TestId, RecognitionCtor: RecognitionCtor | null): Promise<boolean> => {
    switch (test) {
      case 'S1': {
        const stream = await openStream(test)
        return !!stream && startRecorder(stream, test)
      }
      case 'S2': {
        const stream = await ensureStream(test)
        if (!stream) return false
        setTracksEnabled(true)
        return startRecorder(stream, test)
      }
      case 'S3': {
        const stream = await ensureStream(test)
        return !!stream && startRecognition(RecognitionCtor!)
      }
      case 'S4':
        return startRecognition(RecognitionCtor!)
      case 'S5': {
        const stream = await ensureStream(test)
        if (!stream) return false
        setTracksEnabled(true)
        return startRecorder(stream, test) && startRecognition(RecognitionCtor!)
      }
      case 'S7': {
        const stream = await ensureStream(test)
        return !!stream && startRecorder(stream, test)
      }
    }
  }

  const stop = (test: TestId) => {
    addLog(`${test} 停止`)
    switch (test) {
      case 'S1':
        stopRecorder()
        logTracks('S1 停止、stop() の前')
        stopStream()
        addLog('track を stop()（S1）')
        break
      case 'S2':
        stopRecorder()
        setTracksEnabled(false)
        break
      case 'S3':
      case 'S4':
        stopRecognition()
        break
      case 'S5':
        stopRecorder()
        stopRecognition()
        setTracksEnabled(false)
        break
      case 'S7':
        stopRecorder()
        break
    }
    setRunning(null)
    logTracks(`${test} 停止`)
    void logPermission(`${test} 停止`)
  }

  const handleCloseAll = () => {
    addLog('S6 すべて閉じる')
    closeAll()
    discardRecording('S6')
    logTracks('S6 すべて閉じる')
    void logPermission('S6 すべて閉じる')
  }

  // 音声認識がスピーカーの音を拾うことや、iPhone で音声のセッションが切り替わることで、
  // テストの結果に影響しないよう、テストが動いている間と開始を待っている間は再生しない
  const playBlocked = running !== null || busy

  const handlePlay = () => {
    const recording = lastRecordingRef.current
    if (!recording) return
    audioRef.current?.pause()
    const label = recordingLabel(recording)
    logTracks('再生の前')
    const audio = new Audio(recording.url)
    audioRef.current = audio
    audio.onplaying = () => addLog(`再生の開始（${label}）`)
    audio.onended = () => {
      addLog(`再生の終わり（${label}）`)
      logTracks('再生の終わり')
    }
    const fail = (e: unknown) => {
      addLog(`再生の失敗 name=${errorName(e)}（${label}）`)
      logTracks('再生の失敗')
    }
    try {
      void Promise.resolve(audio.play()).catch(fail)
    } catch (e) {
      fail(e)
    }
  }

  const handleCopy = async () => {
    const text = log.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyFallback(false)
      addLog('ログをコピーしました')
    } catch {
      setCopyFallback(true)
      addLog('ログをコピーできませんでした。下の欄を全選択して写してください')
    }
  }

  useEffect(() => {
    if (copyFallback) fallbackRef.current?.select()
  }, [copyFallback])

  // 後片付けと、ページの状態の変化のログ。closeAll などは ref だけを触るので、最初の描画のものを使う
  const closeAllRef = useRef(closeAll)
  const discardRecordingRef = useRef(discardRecording)
  const addLogRef = useRef(addLog)
  useEffect(() => {
    const log = (msg: string) => addLogRef.current(msg)
    const handleVisibility = () => log(`visibilityState=${document.visibilityState}`)
    const handlePageHide = () => {
      log('pagehide すべて閉じる')
      closeAllRef.current()
      discardRecordingRef.current('pagehide')
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', handlePageHide)

    let cancelled = false
    let permissionStatus: PermissionStatus | null = null
    const handlePermissionChange = () => {
      if (permissionStatus) log(`permissions microphone=${permissionStatus.state}（変化）`)
    }
    const watchPermission = async () => {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (cancelled) return
        permissionStatus = status
        status.addEventListener('change', handlePermissionChange)
        log(`permissions microphone=${status.state}（ページを開いたとき）`)
      } catch {
        if (!cancelled) log('permissions microphone=unsupported（ページを開いたとき）')
      }
    }
    void watchPermission()

    const closeAllOnUnmount = closeAllRef.current
    const discardRecordingOnUnmount = discardRecordingRef.current
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageHide)
      permissionStatus?.removeEventListener('change', handlePermissionChange)
      closeAllOnUnmount()
      discardRecordingOnUnmount('コンポーネントが外れた')
    }
  }, [])

  return (
    <main style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '720px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>Mic Test</h1>

      <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>
        マイク動作確認用の開発ページです。録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信・保存しません。音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。録音した音声は、このページの中で再生するためだけにメモリに持ちます。送信も保存もしません。次の録音を始めたとき、S6 を押したとき、ページを閉じたときに捨てます。
      </p>

      <section style={sectionStyle}>
        {TESTS.map(({ id, description }) => {
          const isRunning = running === id
          return (
            <div key={id} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' }}>
              <button
                onClick={() => (isRunning ? stop(id) : void start(id))}
                disabled={busy}
                style={{ padding: '10px 14px', fontSize: '15px', minWidth: '96px', flexShrink: 0 }}
              >
                {isRunning ? `${id} 停止` : `${id} 開始`}
              </button>
              <span style={{ fontSize: '13px', lineHeight: 1.5 }}>{description}</span>
            </div>
          )
        })}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <button
            onClick={handleCloseAll}
            disabled={busy}
            style={{ padding: '10px 14px', fontSize: '15px', minWidth: '96px', flexShrink: 0 }}
          >
            S6 すべて閉じる
          </button>
          <span style={{ fontSize: '13px', lineHeight: 1.5 }}>
            マイク（すべての track を stop()）、録音、音声認識を閉じる。閉じた後に S2 をもう一度始めて、閉じてから開き直したときの動きを確かめる
          </span>
        </div>
      </section>

      <section style={sectionStyle}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={handlePlay}
            disabled={!lastRecording || playBlocked}
            style={{ padding: '10px 14px', fontSize: '15px', flexShrink: 0 }}
          >
            直前の録音を再生
          </button>
          <span data-testid="mic-test-recording" style={{ fontSize: '13px', lineHeight: 1.5 }}>
            {lastRecording ? recordingLabel(lastRecording) : '録音なし（S1、S2、S5、S7 で録音して停止すると再生できます）'}
            {lastRecording && playBlocked && (
              <span data-testid="mic-test-play-blocked">（テストを止めてから再生できます）</span>
            )}
          </span>
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '8px' }}>
          <h2 style={{ fontSize: '16px', margin: 0 }}>ログ</h2>
          <button onClick={() => void handleCopy()} style={{ padding: '6px 12px' }}>ログをコピー</button>
          <button onClick={() => { setLog([]); setCopyFallback(false) }} style={{ padding: '6px 12px' }}>ログを消す</button>
        </div>
        {copyFallback && (
          <textarea
            ref={fallbackRef}
            readOnly
            aria-label="コピー用のログ"
            value={log.join('\n')}
            onFocus={e => e.currentTarget.select()}
            style={{ width: '100%', height: '160px', fontSize: '12px', fontFamily: 'monospace', marginBottom: '8px', boxSizing: 'border-box' }}
          />
        )}
        <div data-testid="mic-test-log" style={logBoxStyle}>
          {log.length === 0 ? (
            <p style={{ color: '#999', margin: 0 }}>（なし）</p>
          ) : (
            log.map((line, i) => <div key={log.length - i}>{line}</div>)
          )}
        </div>
      </section>
    </main>
  )
}
