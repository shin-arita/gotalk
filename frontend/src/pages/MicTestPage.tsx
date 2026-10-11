import { useState, useEffect, useRef } from 'react'

// 開発用のマイクの確認のページ（#mic-test）。
// 国旗を押すたびに出るブラウザのマイクのお知らせが、getUserMedia の開き直しと
// 音声認識の始め直しのどちらで出るのかを、実機で確かめるために使います。
// 録音した音声と音声認識の結果は、送信も保存もせず、ページの中に表示するだけです。

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
      addLog(`track[${i}] readyState=${t.readyState} enabled=${t.enabled}（${when}）`)
    })
  }

  const setTracksEnabled = (enabled: boolean) => {
    streamRef.current?.getTracks().forEach(t => { t.enabled = enabled })
  }

  const openStream = async (test: TestId): Promise<MediaStream | null> => {
    const generation = generationRef.current
    addLog(`getUserMedia 開始（${test}）`)
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
        t.addEventListener('ended', () => addLog(`track[${i}] ended`))
      })
      streamRef.current = stream
      streamOwnerRef.current = test
      return stream
    } catch (e) {
      addLog(`getUserMedia 失敗 name=${errorName(e)}（${test}）`)
      return null
    }
  }

  // 同じテストで開いたマイクがあればそれを使い、なければ開く
  const ensureStream = async (test: TestId): Promise<MediaStream | null> => {
    if (streamRef.current && streamOwnerRef.current === test) return streamRef.current
    return openStream(test)
  }

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    streamOwnerRef.current = null
  }

  const startRecorder = (stream: MediaStream) => {
    const mimeType = getSupportedMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    let bytes = 0
    recorder.ondataavailable = (e: BlobEvent) => { bytes += e.data.size }
    recorder.onstop = () => addLog(`MediaRecorder stop bytes=${bytes}`)
    recorder.start()
    recorderRef.current = recorder
    addLog(`MediaRecorder start mimeType=${recorder.mimeType || mimeType || '（既定）'}`)
  }

  const stopRecorder = () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }

  const startRecognition = (Ctor: RecognitionCtor) => {
    const recognition = new Ctor()
    recognition.lang = 'ja-JP'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => addLog('音声認識 onstart')
    recognition.onaudiostart = () => addLog('音声認識 onaudiostart')
    recognition.onaudioend = () => addLog('音声認識 onaudioend')
    recognition.onend = () => addLog('音声認識 onend')
    recognition.onerror = e => addLog(`音声認識 onerror error=${e.error ?? 'unknown'}`)
    recognition.onresult = e => {
      // 結果の文字列は表示せず、文字数だけを出す
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      addLog(`音声認識 onresult 文字数=${[...text].length}`)
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
      addLog('音声認識 start()')
    } catch (e) {
      addLog(`音声認識 start() 失敗 name=${errorName(e)}`)
    }
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
    addLog(`${test} 開始`)
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
    setBusy(true)
    try {
      switch (test) {
        case 'S1': {
          const stream = await openStream(test)
          if (!stream) return
          startRecorder(stream)
          break
        }
        case 'S2': {
          const stream = await ensureStream(test)
          if (!stream) return
          setTracksEnabled(true)
          startRecorder(stream)
          break
        }
        case 'S3': {
          const stream = await ensureStream(test)
          if (!stream) return
          startRecognition(RecognitionCtor!)
          break
        }
        case 'S4':
          startRecognition(RecognitionCtor!)
          break
        case 'S5': {
          const stream = await ensureStream(test)
          if (!stream) return
          setTracksEnabled(true)
          startRecorder(stream)
          startRecognition(RecognitionCtor!)
          break
        }
        case 'S7': {
          const stream = await ensureStream(test)
          if (!stream) return
          startRecorder(stream)
          break
        }
      }
      setRunning(test)
      logTracks(`${test} 開始`)
      void logPermission(`${test} 開始`)
    } finally {
      setBusy(false)
    }
  }

  const stop = (test: TestId) => {
    addLog(`${test} 停止`)
    switch (test) {
      case 'S1':
        stopRecorder()
        stopStream()
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
    logTracks('S6 すべて閉じる')
    void logPermission('S6 すべて閉じる')
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
  const addLogRef = useRef(addLog)
  useEffect(() => {
    const log = (msg: string) => addLogRef.current(msg)
    const handleVisibility = () => log(`visibilityState=${document.visibilityState}`)
    const handlePageHide = () => {
      log('pagehide すべて閉じる')
      closeAllRef.current()
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
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageHide)
      permissionStatus?.removeEventListener('change', handlePermissionChange)
      closeAllOnUnmount()
    }
  }, [])

  return (
    <main style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '720px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>Mic Test</h1>

      <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>
        マイク動作確認用の開発ページです。録音した音声と音声認識の結果は、GoTalk の Backend や OpenAI API には送信・保存しません。音声認識を使うテスト（S3、S4、S5）では、ブラウザまたは OS の音声認識サービスへ音声が送信される場合があります。
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
