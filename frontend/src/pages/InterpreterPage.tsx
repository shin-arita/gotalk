import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { Language } from '../languages'
import { API_TIMEOUT_MS, ApiError, MAX_INTERPRET_AUDIO_BYTES, MIN_INTERPRET_AUDIO_BYTES, apiErrorCode, apiErrorFromResponse, isTooLongForTts, logApiError, messageKeyForCode, messageKeyForError } from '../api'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import { useInterpreterAudioSession } from '../hooks/useKeptAudioSession'
import type { AudioSessionAbortReason, AudioSessionStartFailure } from '../hooks/useAudioSession'
import { DEFAULT_EXPERIMENT_CONFIG } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import ExperimentPanel from './ExperimentPanel'
import './InterpreterPage.css'

// 画面全体の状態（docs/speech-flow.md）。状態は画面だけが持つ
// idle: 何もしていない / starting: マイクを開いて録音を始めている途中 / recording: 録音の成立の後、話している /
// stopping: 利用者が止めて、録音の最後のデータを待っている / processing: 文字起こしと翻訳を待っている /
// ready: 翻訳の結果が出ている / speaking: 読み上げている / error: 失敗の後の片付けの途中（短い間）
type InterpreterStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'processing' | 'ready' | 'speaking' | 'error'

interface InterpreterPageProps {
  selectedLanguages: Language[]
  onBack: () => void
  // 切り分けの実験のスイッチ（docs/testing.md）。省略したときは、すべてのスイッチが false で、今の本番と同じ動き。
  // 最初の描画のときの値だけを使う
  experiment?: ExperimentConfig
}

interface HistoryEntry {
  id: string
  date: string
  time: string
  source: string
  translation: string
  backTranslation: string
  sourceLangId: string
  targetLangId: string
}

const LANG_LOCALE: Record<string, string> = {
  'ja':    'ja-JP',
  'en':    'en-US',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  'ko':    'ko-KR',
  'th':    'th-TH',
  'vi':    'vi-VN',
}

const TRANSLATING_MESSAGES: Record<string, string> = {
  'ja':    'ただいま翻訳中です',
  'en':    'Translating now',
  'zh-CN': '正在翻译中',
  'zh-TW': '正在翻譯中',
  'ko':    '번역 중입니다',
  'th':    'กำลังแปลอยู่',
  'vi':    'Đang dịch',
}

const PLEASE_WAIT_MESSAGES: Record<string, string> = {
  'ja':    'しばらくお待ちください',
  'en':    'Please wait a moment',
  'zh-CN': '请稍候',
  'zh-TW': '請稍候',
  'ko':    '잠시만 기다려 주세요',
  'th':    'กรุณารอสักครู่',
  'vi':    'Vui lòng chờ một chút',
}

const BACK_TRANSLATION_LABELS: Record<string, string> = {
  'ja':    '逆翻訳',
  'en':    'Back translation',
  'zh-CN': '反向翻译',
  'zh-TW': '反向翻譯',
  'ko':    '역번역',
  'th':    'คำแปลย้อนกลับ',
  'vi':    'Dịch ngược',
}

const FLAG_TAP_MESSAGES: Record<string, string> = {
  'ja':    '国旗をタップして話してください。',
  'en':    'Tap the flag to speak.',
  'zh-CN': '点击国旗开始说话。',
  'zh-TW': '點擊國旗開始說話。',
  'ko':    '국기를 탭하여 말씀해 주세요.',
  'th':    'แตะธงเพื่อพูด',
  'vi':    'Nhấn vào cờ để nói.',
}

// 録音中の画面（docs/ui.md）の案内の文言と、下のボタンの aria-label。押した国旗の言語の1言語だけを出す
const RECORDING_GUIDE_MESSAGES: Record<string, string> = {
  'ja':    '話し終わったら画面をタップしてください',
  'en':    'When you finish speaking, tap the screen.',
  'zh-CN': '说完后请点击屏幕。',
  'zh-TW': '說完後請點擊螢幕。',
  'ko':    '말씀이 끝나면 화면을 탭해 주세요.',
  'th':    'เมื่อพูดจบแล้ว กรุณาแตะหน้าจอ',
  'vi':    'Khi nói xong, vui lòng chạm vào màn hình.',
}

const STOP_BUTTON_LABELS: Record<string, string> = {
  'ja':    '停止',
  'en':    'Stop',
  'zh-CN': '停止',
  'zh-TW': '停止',
  'ko':    '정지',
  'th':    'หยุด',
  'vi':    'Dừng',
}

const CANCEL_BUTTON_LABELS: Record<string, string> = {
  'ja':    'キャンセル',
  'en':    'Cancel',
  'zh-CN': '取消',
  'zh-TW': '取消',
  'ko':    '취소',
  'th':    'ยกเลิก',
  'vi':    'Hủy',
}

// 棒グラフを動かし続ける時間（ms）。音声認識の途中の文字がこの間に変わらなければ止める
const TEXT_FLOW_HOLD_MS = 800

// 録音中の画面が消えた後に、タップの通り抜け（ghost click）を受け止める透明な盾を出す時間（ms）
const CLICK_SHIELD_MS = 400

// pagehide のときの状態から、bfcache から戻ったとき（pageshow の persisted）にするべき状態（docs/speech-flow.md）
const PAGESHOW_RECOVERY_STATUS: Record<InterpreterStatus, InterpreterStatus> = {
  idle: 'idle',
  starting: 'idle',
  recording: 'idle',
  stopping: 'idle',
  processing: 'idle',
  ready: 'ready',
  speaking: 'ready',
  error: 'idle',
}

// 録音の長さを測る時刻（ミリ秒）。callback の中だけで呼ぶ
const nowMs = () => Date.now()

// 診断のログに残す、例外の名前
function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : typeof e
}

export default function InterpreterPage({ selectedLanguages, onBack, experiment = DEFAULT_EXPERIMENT_CONFIG }: InterpreterPageProps) {
  const [status, setStatus] = useState<InterpreterStatus>('idle')
  const [recordingFlagIndex, setRecordingFlagIndex] = useState<0 | 1 | null>(null)
  const [recognizedText, setRecognizedText] = useState('')
  const [liveTranslatedText, setLiveTranslatedText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [backTranslation, setBackTranslation] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [processingMsgIdx, setProcessingMsgIdx] = useState(0)
  const [processingLangs, setProcessingLangs] = useState<[string, string] | null>(null)
  // 録音中の画面の棒グラフが動いているか（音声認識の途中の文字が届いている間だけ true）
  const [isTextFlowing, setIsTextFlowing] = useState(false)
  // 録音中の画面が消えた後の、タップの通り抜けの守り（click shield）を出しているか
  const [shieldVisible, setShieldVisible] = useState(false)

  const backTranslationLabel = selectedLanguages.length === 2
    ? `${BACK_TRANSLATION_LABELS[selectedLanguages[0].id] ?? '逆翻訳'} / ${BACK_TRANSLATION_LABELS[selectedLanguages[1].id] ?? '逆翻訳'}`
    : '逆翻訳'

  // 非同期の callback の中では、React の状態ではなく、これらの ref でその時点の最新の値を読む
  const statusRef = useRef<InterpreterStatus>('idle')
  // 読み上げ用の AudioContext（画面で1つ。最初の読み上げのタップのときに作る）と、今鳴らしている音、
  // onended が来ないときの見張りのタイマー（docs/speech-flow.md の「読み上げ」）
  const ttsContextRef = useRef<AudioContext | null>(null)
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const ttsWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 読み上げの番号（/api/tts の問い合わせと AudioContext での再生）。今有効な番号を1つだけ持つ
  const ttsSeqRef = useRef(0)
  const activeTtsIdRef = useRef<number | null>(null)
  const ttsControllerRef = useRef<AbortController | null>(null)
  // 翻訳の問い合わせ（/api/interpret と、編集した文の /api/translate）の番号。今有効な番号を1つだけ持つ
  const requestSeqRef = useRef(0)
  const activeRequestIdRef = useRef<number | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  // pagehide のときに記録する、bfcache から戻ったときにするべき状態
  const pagehideRecoveryStatusRef = useRef<InterpreterStatus | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const recordingLangRef = useRef<Language | null>(null)
  const hasLiveTranscriptRef = useRef(false)
  const recognizedTextRef = useRef('')
  // 画面が recording になった時刻（録音の長さを測り、マイクの音が来ていないかの判定に使う）
  const recordingStartedAtRef = useRef<number | null>(null)
  // 棒グラフの見張り。送信用の recognizedTextRef とは別に、最後に棒グラフを動かした文字を持つ
  const lastFlowTranscriptRef = useRef('')
  const flowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 録音中の画面の文字の領域と下のボタン、前の描画のときに録音中の画面を出していたか、盾のタイマー
  const overlayTextRef = useRef<HTMLDivElement>(null)
  const overlayButtonRef = useRef<HTMLButtonElement>(null)
  const prevOverlayVisibleRef = useRef(false)
  const shieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 切り分けの実験のスイッチ。最初の描画のときの値だけを使う
  const experimentRef = useRef(experiment)

  // 録音のセッション。状態は持たず、録音の成立、最後のデータ、失敗を callback で知らせる。
  // useAudioSession の実験のスイッチがあるときは今の useAudioSession を、ないときはマイクを閉じないセッションを使う
  const audioSession = useInterpreterAudioSession({
    onRecordingStarted: () => handleRecordingStarted(),
    onStartFailed: (failure, reason) => handleStartFailed(failure, reason),
    onTranscript: (transcript) => {
      hasLiveTranscriptRef.current = true
      recognizedTextRef.current = transcript
      setRecognizedText(transcript)
      // 棒グラフは、録音中（recording）に文字が変わったときだけ動かし続ける（同じ文字がもう一度届いても延長しない。
      // 停止の後に遅れて届いた最後の文字では動かさない。その文字も送信と表示には使う）
      if (statusRef.current === 'recording' && transcript !== lastFlowTranscriptRef.current) {
        lastFlowTranscriptRef.current = transcript
        setIsTextFlowing(true)
        if (flowTimerRef.current !== null) clearTimeout(flowTimerRef.current)
        flowTimerRef.current = setTimeout(() => {
          flowTimerRef.current = null
          setIsTextFlowing(false)
        }, TEXT_FLOW_HOLD_MS)
      }
    },
    // 声の大きさは画面に出さない（セッションは今までどおり測り、診断に残す）
    onLevel: () => {},
    onRecordingStopped: (blob) => handleRecordingStopped(blob),
    onRecorderError: () => handleRecorderError(),
    isRecordingStatus: () => statusRef.current === 'recording',
  }, experiment)

  // 画面の状態を変える。状態は画面だけが持つ（statusRef は、非同期の callback から最新の値を読むため）
  const changeStatus = (next: InterpreterStatus) => {
    statusRef.current = next
    setStatus(next)
    audioSession.logEvent(`status:${next}`)
  }

  const addHistoryEntry = (source: string, translation: string, bt: string, srcId: string, tgtId: string) => {
    const now = new Date()
    const locale = LANG_LOCALE[srcId] ?? 'ja-JP'
    setHistory(prev => [{
      id: String(Date.now()),
      date: now.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
      time: now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
      source,
      translation,
      backTranslation: bt,
      sourceLangId: srcId,
      targetLangId: tgtId,
    }, ...prev])
  }

  // 利用者向けの文言を、選んだ2つの言語で表示する（docs/ui.md）
  const showMessage = (messageKey: MessageKey) => {
    setErrorMessage(getLocalizedMessage(messageKey, selectedLanguages[0]?.id, selectedLanguages[1]?.id))
  }

  const handleLangMismatch = () => {
    showMessage('language_unclear')
    setTranslatedText('')
    setBackTranslation('')
    changeStatus('idle')
  }

  // 翻訳の問い合わせを始める。今有効な問い合わせの番号を新しい番号にする
  const beginRequest = () => {
    requestSeqRef.current += 1
    const id = requestSeqRef.current
    const controller = new AbortController()
    activeRequestIdRef.current = id
    requestControllerRef.current = controller
    return { id, controller }
  }

  const isActiveRequest = (id: number) => activeRequestIdRef.current === id

  const endRequest = (id: number) => {
    if (!isActiveRequest(id)) return
    activeRequestIdRef.current = null
    requestControllerRef.current = null
  }

  // 翻訳の問い合わせを止め、今有効な問い合わせの番号を「なし」にする。後から戻る結果や失敗は画面に反映しない
  const abortTranslationRequest = () => {
    const controller = requestControllerRef.current
    activeRequestIdRef.current = null
    requestControllerRef.current = null
    controller?.abort()
  }

  const callInterpretApi = async (audioBlob: Blob) => {
    changeStatus('processing')
    setErrorMessage('')

    const mimeType = audioBlob.type || 'audio/webm'
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm'

    const speakerLang = recordingLangRef.current ?? selectedLanguages[0]
    const otherLang = speakerLang.id === selectedLanguages[0].id ? selectedLanguages[1] : selectedLanguages[0]
    setProcessingLangs([speakerLang.id, otherLang.id])

    const formData = new FormData()
    formData.append('audio', audioBlob, `recording.${ext}`)
    formData.append('myLanguage', JSON.stringify({ id: speakerLang.id, label: speakerLang.label }))
    formData.append('theirLanguage', JSON.stringify({ id: otherLang.id, label: otherLang.label }))
    formData.append('speaker', speakerLang.id)
    // Web Speech API のテキストがあれば送信 → バックエンドが Whisper 再文字起こしをスキップして翻訳に使用
    if (hasLiveTranscriptRef.current && recognizedTextRef.current) {
      formData.append('transcript', recognizedTextRef.current)
    }

    const { id, controller } = beginRequest()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.interpret)
    try {
      // 明らかに大きい録音は送らない（nginx の 413 になるため。MAX_INTERPRET_AUDIO_BYTES を参照）
      if (audioBlob.size > MAX_INTERPRET_AUDIO_BYTES) throw new ApiError('recording_too_long', '/api/interpret', null, 'recording_too_large_before_send')

      const res = await fetch('/api/interpret', { method: 'POST', body: formData, signal: controller.signal })
      if (!isActiveRequest(id)) return

      // 413 は、Backend の JSON（input_too_large）でも nginx の HTML でも、同じ文言にする
      if (res.status === 413) throw new ApiError('recording_too_long', '/api/interpret', 413, 'request_too_large')

      if (res.status === 422) {
        const data = await res.json()
        if (!isActiveRequest(id)) return
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw await apiErrorFromResponse('/api/interpret', res)

      const data = await res.json()
      if (!isActiveRequest(id)) return
      if (!hasLiveTranscriptRef.current) { recognizedTextRef.current = data.text; setRecognizedText(data.text) }
      hasLiveTranscriptRef.current = false
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      changeStatus('ready')
      addHistoryEntry(data.text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      // 止めた問い合わせ（pagehide、戻る、外れる）の失敗は、画面に反映しない
      if (!isActiveRequest(id)) return
      showMessage(messageKeyForError('/api/interpret', e))
      changeStatus('idle')
    } finally {
      clearTimeout(timer)
      endRequest(id)
    }
  }

  // テキスト編集後の再翻訳にのみ使用
  const callTranslateApi = async (text: string) => {
    // 読み上げの途中に編集した場合は、読み上げを止める
    stopSpeaking()
    // 失敗したときに、前の翻訳の結果が残っていれば、読み上げを押せる ready に戻す
    const hadTranslation = !!ttsText
    changeStatus('processing')
    setErrorMessage('')
    const srcLang = recordingLangRef.current ?? selectedLanguages[0]
    const tgtLang = srcLang.id === selectedLanguages[0].id ? selectedLanguages[1] : selectedLanguages[0]
    setProcessingLangs([srcLang.id, tgtLang.id])
    const { id, controller } = beginRequest()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.translate)
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
        signal: controller.signal,
      })
      if (!isActiveRequest(id)) return
      if (res.status === 422) {
        const data = await res.json()
        if (!isActiveRequest(id)) return
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw await apiErrorFromResponse('/api/translate', res)
      const data = await res.json()
      if (!isActiveRequest(id)) return
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      changeStatus('ready')
      addHistoryEntry(text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      if (!isActiveRequest(id)) return
      showMessage(messageKeyForError('/api/translate', e))
      changeStatus(hadTranslation ? 'ready' : 'idle')
    } finally {
      clearTimeout(timer)
      endRequest(id)
    }
  }

  // 録音中のリアルタイム翻訳（800ms デバウンス）。テキストや画面の状態が変わったら、送信中の fetch も abort する
  useEffect(() => {
    if (status !== 'recording' || !recognizedText) return
    const controller = new AbortController()
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(async () => {
      timeoutTimer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.translate)
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: recognizedText, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
          signal: controller.signal,
        })
        if (!res.ok) return
        const data = await res.json()
        if (data.translatedText && data.sourceLanguage !== 'unknown') setLiveTranslatedText(data.translatedText)
      } catch { /* AbortError やネットワークエラーは無視 */ } finally {
        clearTimeout(timeoutTimer)
      }
    }, 800)
    return () => { clearTimeout(timer); clearTimeout(timeoutTimer); controller.abort() }
  }, [recognizedText, status, selectedLanguages])

  useEffect(() => {
    if (status !== 'processing') return
    const id = setInterval(() => setProcessingMsgIdx(i => (i + 1) % 2), 1200)
    return () => { clearInterval(id); setProcessingMsgIdx(0) }
  }, [status])

  // 棒グラフを止め、タイマーと最後の文字を片付ける
  const resetTextFlow = () => {
    if (flowTimerRef.current !== null) {
      clearTimeout(flowTimerRef.current)
      flowTimerRef.current = null
    }
    lastFlowTranscriptRef.current = ''
    setIsTextFlowing(false)
  }

  // 読み上げを止める（今鳴らしている音を止めてつなぎを外し、見張りのタイマーと /api/tts の問い合わせも止める）。冪等。
  // AudioContext は閉じない（画面で使い回す）
  const stopSpeaking = () => {
    activeTtsIdRef.current = null
    const controller = ttsControllerRef.current
    ttsControllerRef.current = null
    controller?.abort()
    if (ttsWatchdogRef.current !== null) {
      clearTimeout(ttsWatchdogRef.current)
      ttsWatchdogRef.current = null
    }
    const source = ttsSourceRef.current
    ttsSourceRef.current = null
    if (source) {
      source.onended = null
      try { source.stop() } catch { /* 止める処理の例外は捨てる */ }
      try { source.disconnect() } catch { /* 外す処理の例外は捨てる */ }
    }
  }

  // 録音の成立（マイク ON）
  const handleRecordingStarted = () => {
    if (statusRef.current !== 'starting') {
      // 中断はセッションを先に無効にするので、ここには来ない。来た場合は録音を片付ける
      void audioSession.abort('error')
      return
    }
    recordingStartedAtRef.current = nowMs()
    changeStatus('recording')
  }

  // 録音の成立までの失敗。hook が資源を片付けた後に呼ばれる
  const handleStartFailed = (failure: AudioSessionStartFailure, reason: string) => {
    console.warn('[GoTalk] microphone error', { reason })
    resetTextFlow()
    changeStatus('error')
    showMessage(failure)
    setRecordingFlagIndex(null)
    changeStatus('idle')
  }

  // 録音の成立の後の失敗（MediaRecorder の onerror など）。hook が中断の片付け（理由 error）をした後に呼ばれる
  const handleRecorderError = () => {
    changeStatus('error')
    resetTextFlow()
    showMessage('recording_failed')
    setRecordingFlagIndex(null)
    changeStatus('idle')
  }

  // 利用者の停止で、録音の最後のデータがそろった後に呼ばれる。ここで初めて processing に進み、Backend に送る。
  // 音声認識の文字がなく、録音のデータがほとんどないときは送らない（docs/speech-flow.md の「マイクの音が来ないときの検出」）
  const handleRecordingStopped = (blob: Blob) => {
    resetTextFlow()
    if (statusRef.current !== 'stopping') return
    const startedAt = recordingStartedAtRef.current
    recordingStartedAtRef.current = null
    const hasTranscript = hasLiveTranscriptRef.current && !!recognizedTextRef.current
    if (!hasTranscript && blob.size < MIN_INTERPRET_AUDIO_BYTES) {
      const durationMs = startedAt === null ? 0 : nowMs() - startedAt
      setRecordingFlagIndex(null)
      if (durationMs >= 1000) {
        // 1 秒以上録音したのに中身がない：マイクの音が来ていない
        audioSession.logEvent(`no_audio_detected:bytes=${blob.size},ms=${durationMs}`)
        showMessage('microphone_no_audio')
      } else {
        // 押してすぐ止めた
        showMessage('recording_failed')
      }
      changeStatus('idle')
      return
    }
    setRecordingFlagIndex(null)
    void callInterpretApi(blob)
  }

  const stopRecording = () => {
    if (statusRef.current !== 'recording') return
    changeStatus('stopping')
    resetTextFlow()
    audioSession.stop()
  }

  // マイクの準備の途中（starting）の取り消し（録音中の画面の × のボタン）。文言は出さない。
  // getUserMedia を待っている間なら、セッションが取得した stream を残して次の録音で使い回す（中断と同じ）
  const handleCancelStarting = () => {
    if (statusRef.current !== 'starting') return
    void audioSession.abort('cancel')
    resetTextFlow()
    setRecordingFlagIndex(null)
    changeStatus('idle')
  }

  const handleFlagTap = (flagIndex: 0 | 1) => {
    const current = statusRef.current
    if (current === 'recording') {
      if (recordingFlagIndex === flagIndex) stopRecording()
      return
    }
    // starting、stopping、processing、speaking、error の間は受け付けない
    if (current !== 'idle' && current !== 'ready') return
    recognizedTextRef.current = ''
    hasLiveTranscriptRef.current = false
    setRecognizedText('')
    setLiveTranslatedText('')
    setTranslatedText('')
    setTtsText('')
    setBackTranslation('')
    setErrorMessage('')
    resetTextFlow()
    const lang = selectedLanguages[flagIndex]
    recordingLangRef.current = lang
    setRecordingFlagIndex(flagIndex)
    changeStatus('starting')
    void audioSession.start(lang.speechCode)
  }

  // 読み上げの前に残っている録音のセッションを、異常として記録してから片付ける（hasActiveSession() のときに呼ぶ。
  // 呼ぶ側で確かめるのは、残っていない正常な経路で await を挟まないため）
  const abortLeftoverSessionBeforeTts = (): Promise<void> => {
    audioSession.logEvent('unexpected_active_audio_session_before_tts')
    console.warn('[GoTalk] unexpected_active_audio_session_before_tts')
    return audioSession.abort('error')
  }

  // 読み上げを AudioContext で鳴らす（docs/speech-flow.md の「読み上げ」）。マイクを開いたまま <audio> で鳴らすと、
  // 次の録音が壊れるため、<audio> は使わない（失敗しても <audio> に切り替えて鳴らし直さない）
  const handleSpeak = async () => {
    if (statusRef.current !== 'ready') return
    // 読み上げの時間の記録（docs/speech-flow.md の「読み上げ」）。events の at が時刻
    audioSession.logEvent('tts_tap')
    setErrorMessage('')
    // 上限を超える翻訳の結果は読み上げない（翻訳の結果の表示はそのまま）
    if (isTooLongForTts(ttsText)) {
      showMessage('tts_too_long')
      return
    }
    // await の前（タップの処理の中）で resume() を呼ぶ（iPhone では、利用者の操作の中でないと鳴らせないため）。
    // ここでは待たず、再生を始める直前に結果を確かめる。拒否が未処理にならないよう、catch を付けておく
    if (!ttsContextRef.current) {
      // 作れないとき（AudioContext がない、作れる数の上限など）は、読み上げの失敗として、文言を出さずに ready のまま戻る。
      // 鳴らせないので /api/tts は呼ばない。ttsContextRef は空のままにして、次のタップでもう一度作るのを試す
      try {
        ttsContextRef.current = new AudioContext()
      } catch (e) {
        audioSession.logEvent(`tts_context_create_failed:${errorName(e)}`)
        logApiError('/api/tts', e)
        // 戻る前に、下の守りと同じく、残っている録音のセッションを記録して片付ける
        if (audioSession.hasActiveSession()) await abortLeftoverSessionBeforeTts()
        return
      }
    }
    const ctx = ttsContextRef.current
    let resumed: Promise<void>
    try {
      resumed = ctx.resume()
    } catch (e) {
      resumed = Promise.reject(e)
    }
    resumed.catch(() => {})
    // 読み上げの前に録音のセッションが残っていれば、異常として記録し、片付けが終わるのを待ってから鳴らす
    // （マイクは開いたままが正常で、残っていてはいけないのは録音のセッション。ここで吸収して終わりにせず、
    // 片付けの不具合として直すこと）
    if (audioSession.hasActiveSession()) {
      await abortLeftoverSessionBeforeTts()
      if (statusRef.current !== 'ready') return
    }
    changeStatus('speaking')
    stopSpeaking()
    ttsSeqRef.current += 1
    const ttsId = ttsSeqRef.current
    activeTtsIdRef.current = ttsId
    const controller = new AbortController()
    ttsControllerRef.current = controller
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.tts)
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText }),
        signal: controller.signal,
      })
      audioSession.logEvent(`tts_response:status=${res.status}`)
      if (activeTtsIdRef.current !== ttsId) return
      if (!res.ok) {
        // 利用者に知らせるべきエラー（混み合っている、など）だけを表示する。
        // input_too_large は、Frontend と Backend の文字数の判定がずれた場合などへの備え
        const code = await apiErrorCode(res)
        const messageKey = code === 'input_too_large' ? 'tts_too_long' : messageKeyForCode(code)
        throw new ApiError(messageKey, '/api/tts', res.status, code)
      }
      const data = await res.arrayBuffer()
      audioSession.logEvent(`tts_downloaded:bytes=${data.byteLength}`)
      if (activeTtsIdRef.current !== ttsId) return
      const buffer = await ctx.decodeAudioData(data)
      audioSession.logEvent(`tts_decoded:ms=${Math.round(buffer.duration * 1000)}`)
      if (activeTtsIdRef.current !== ttsId) return
      // resume() の結果を確かめる。拒否されたとき、または running でないときは鳴らさず、読み上げの失敗とする
      // （文言は出さない）
      let resumeError: unknown = null
      try {
        await resumed
      } catch (e) {
        resumeError = e
      }
      if (activeTtsIdRef.current !== ttsId) return
      if (resumeError !== null || ctx.state !== 'running') {
        audioSession.logEvent(resumeError !== null ? `tts_resume_rejected:${errorName(resumeError)}` : `tts_resume_not_running:${ctx.state}`)
        logApiError('/api/tts', resumeError ?? new Error(`AudioContext is ${ctx.state}`))
        stopSpeaking()
        changeStatus('ready')
        return
      }
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      ttsSourceRef.current = source
      source.onended = () => {
        if (activeTtsIdRef.current !== ttsId) return
        stopSpeaking()
        changeStatus('ready')
      }
      source.start()
      audioSession.logEvent('tts_started')
      // onended が来ないまま speaking に残らないよう（iPhone の割り込みなどで再生が止まったとき）、見張りのタイマーを始める
      ttsWatchdogRef.current = setTimeout(() => {
        ttsWatchdogRef.current = null
        if (activeTtsIdRef.current !== ttsId) return
        audioSession.logEvent('tts_ended_timeout')
        stopSpeaking()
        changeStatus('ready')
      }, buffer.duration * 1000 + 3000)
    } catch (e) {
      // 止めた読み上げ（hidden、pagehide など）の失敗は、画面に反映しない
      if (activeTtsIdRef.current !== ttsId) return
      // 表示する文言がないエラー（ネットワークのエラー、timeout、decodeAudioData の失敗など）は、ログにだけ残して何も表示しない
      logApiError('/api/tts', e)
      if (e instanceof ApiError && e.messageKey) showMessage(e.messageKey)
      stopSpeaking()
      changeStatus('ready')
    } finally {
      clearTimeout(timer)
      if (ttsControllerRef.current === controller) ttsControllerRef.current = null
    }
  }

  // 中断の片付け（docs/speech-flow.md の中断の表）。hidden は一時的に離れること、pagehide はページを離れること、
  // back と unmount は画面が外れること
  const interrupt = (reason: AudioSessionAbortReason) => {
    const current = statusRef.current
    const leavingScreen = reason === 'back' || reason === 'unmount'
    if (reason === 'pagehide') pagehideRecoveryStatusRef.current = PAGESHOW_RECOVERY_STATUS[current]
    resetTextFlow()

    if (current === 'starting' || current === 'recording' || current === 'stopping' || current === 'error') {
      void audioSession.abort(reason)
      setRecordingFlagIndex(null)
      if (!leavingScreen) changeStatus('idle')
    } else if (current === 'speaking') {
      stopSpeaking()
      if (!leavingScreen) changeStatus('ready')
    } else if (current === 'processing' && reason !== 'hidden') {
      // hidden のときは processing のまま、問い合わせを続ける
      abortTranslationRequest()
      if (reason === 'pagehide') changeStatus('idle')
    }

    // ページや画面を離れるときは、ほかに残っているものがあれば片付ける（冪等）
    if (reason !== 'hidden') {
      void audioSession.abort(reason)
      abortTranslationRequest()
      stopSpeaking()
    }
    // 画面が外れるときは、読み上げ用の AudioContext を閉じる（読み上げの出力用で、マイクではない）。盾のタイマーも消す
    if (reason === 'unmount') {
      if (shieldTimerRef.current !== null) {
        clearTimeout(shieldTimerRef.current)
        shieldTimerRef.current = null
      }
      const ctx = ttsContextRef.current
      ttsContextRef.current = null
      if (ctx) void ctx.close().catch(() => { /* close() の拒否は捨てる */ })
    }
  }

  // bfcache から戻ったとき（persisted）に、pagehide のときに記録した状態に明示的に直す。マイクは開かず、
  // 問い合わせもやり直さず、メッセージも出さない。ふつうの読み込み（persisted でない）では何もしない
  const handlePageShow = (persisted: boolean) => {
    if (!persisted) return
    let recovery = pagehideRecoveryStatusRef.current
    pagehideRecoveryStatusRef.current = null
    const hasLeftover = audioSession.hasActiveSession()
      || activeRequestIdRef.current !== null
      || activeTtsIdRef.current !== null
      || ttsSourceRef.current !== null
    if (hasLeftover) {
      audioSession.logEvent('unexpected_active_session_after_pageshow')
      console.warn('[GoTalk] unexpected_active_session_after_pageshow')
      void audioSession.abort('pagehide')
      abortTranslationRequest()
      stopSpeaking()
      recovery ??= PAGESHOW_RECOVERY_STATUS[statusRef.current]
    }
    if (recovery === null) return
    setRecordingFlagIndex(null)
    changeStatus(recovery)
  }

  const handleBack = () => {
    interrupt('back')
    onBack()
  }

  // listener は一度だけ登録し、最新の処理を ref から呼ぶ
  const interruptRef = useRef(interrupt)
  const pageShowRef = useRef(handlePageShow)
  // 切り分けの実験（trace）の記録。AudioSession は画面が外れるまで同じもの
  const audioSessionRef = useRef(audioSession)
  useEffect(() => {
    interruptRef.current = interrupt
    pageShowRef.current = handlePageShow
  })

  useEffect(() => {
    const handlers = { interruptRef, pageShowRef }
    const exp = experimentRef.current
    const session = audioSessionRef.current
    const onVisibilityChange = () => {
      // 実験の trace：もともとある handler の中で記録する
      if (exp.trace) session.recordPageEvent('visibilitychange')
      if (document.visibilityState === 'hidden') handlers.interruptRef.current('hidden')
    }
    const onPageHide = (e: PageTransitionEvent) => {
      if (exp.trace) session.recordPageEvent('pagehide', e.persisted)
      handlers.interruptRef.current('pagehide')
    }
    const onPageShow = (e: PageTransitionEvent) => {
      if (exp.trace) session.recordPageEvent('pageshow', e.persisted)
      handlers.pageShowRef.current(e.persisted)
    }
    // 実験の nolifecycle と trace：本来の handler を付けないので、記録のためだけの listener を付ける。
    // 時刻、出来事の名前、visibilityState の記録だけをし、中断の片付けや状態の変更などの処理は一切しない
    const recordOnlyVisibilityChange = () => session.recordPageEvent('visibilitychange')
    const recordOnlyPageHide = (e: PageTransitionEvent) => session.recordPageEvent('pagehide', e.persisted)
    const recordOnlyPageShow = (e: PageTransitionEvent) => session.recordPageEvent('pageshow', e.persisted)
    // 実験の nolifecycle：visibilitychange、pagehide、pageshow の listener を付けない
    if (!exp.noLifecycle) {
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('pageshow', onPageShow)
    } else if (exp.trace) {
      document.addEventListener('visibilitychange', recordOnlyVisibilityChange)
      window.addEventListener('pagehide', recordOnlyPageHide)
      window.addEventListener('pageshow', recordOnlyPageShow)
      session.markTraceListenerOnly()
    }
    return () => {
      if (!exp.noLifecycle) {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('pageshow', onPageShow)
      } else if (exp.trace) {
        document.removeEventListener('visibilitychange', recordOnlyVisibilityChange)
        window.removeEventListener('pagehide', recordOnlyPageHide)
        window.removeEventListener('pageshow', recordOnlyPageShow)
      }
      handlers.interruptRef.current('unmount')
    }
  }, [])

  // 原文の入力と編集を始める。原文があればその文字を入れた状態で（話した文の手直し）、空なら空の状態で始める。
  // iPhone では、タップの処理の中で focus() を呼ばないとキーボードが出ないことがあるので、flushSync で textarea を
  // 描画してから、同じ処理の中でフォーカスを移す（docs/ui.md）
  const handleEditStart = () => {
    flushSync(() => {
      setEditValue(recognizedText)
      setIsEditing(true)
    })
    const el = editRef.current
    if (!el) return
    fitEditHeight(el)
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  const handleEditConfirm = () => {
    if (!isEditing) return
    setIsEditing(false)
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === recognizedText) return
    // 編集できるのは idle、ready、speaking のときだけ（録音や問い合わせの途中は受け付けない）
    if (!['idle', 'ready', 'speaking'].includes(statusRef.current)) return
    recognizedTextRef.current = trimmed
    setRecognizedText(trimmed)
    void callTranslateApi(trimmed)
  }

  const handleEditChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditValue(e.target.value)
    fitEditHeight(e.target)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の入力の変換を確定する Enter では、文を確定しない
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditConfirm() }
    if (e.key === 'Escape') setIsEditing(false)
  }

  // 編集の間の透明な覆いのタップ。確定（blur の handler の handleEditConfirm）のほかに何も起こさない。
  // mousedown の既定の動き（フォーカスの移動）を止めるのは、click の前に blur で覆いが消えて、
  // click が下の要素（国旗など）に届かないようにするため
  const handleEditShieldMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
  }

  const handleEditShieldTap = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    editRef.current?.blur()
  }

  // 編集の間に、原文のカードの textarea の外（余白と鉛筆のボタンの位置）をタップしたときも確定する
  const handleSourceCardTap = (e: React.MouseEvent) => {
    if (!isEditing || e.target === editRef.current) return
    editRef.current?.blur()
  }

  const canEdit = !isEditing && (status === 'idle' || status === 'ready' || status === 'speaking')

  const canTapFlag = (i: 0 | 1): boolean => {
    if (status === 'recording') return recordingFlagIndex === i
    return status === 'idle' || status === 'ready'
  }

  // 録音中の画面（docs/ui.md）。starting と recording の間だけ出す（stopping になった時点で消える）
  const overlayVisible = (status === 'starting' || status === 'recording') && recordingFlagIndex !== null
  const overlayLangId = recordingFlagIndex !== null ? selectedLanguages[recordingFlagIndex]?.id : undefined
  const recordingGuide = (overlayLangId && RECORDING_GUIDE_MESSAGES[overlayLangId]) || RECORDING_GUIDE_MESSAGES['en']
  const overlayButtonLabels = status === 'recording' ? STOP_BUTTON_LABELS : CANCEL_BUTTON_LABELS
  const overlayButtonLabel = (overlayLangId && overlayButtonLabels[overlayLangId]) || overlayButtonLabels['en']
  // 録音中の画面と盾を出している間は、下の要素を操作できないようにする
  const underlayInert = overlayVisible || shieldVisible

  // 録音中の画面が出たら下のボタンにフォーカスを移し、消えたら（理由を問わない）盾を出す。
  // 画面が消える描画と盾が出る描画の間を空けないよう、useLayoutEffect で変化を見る
  useLayoutEffect(() => {
    const prev = prevOverlayVisibleRef.current
    prevOverlayVisibleRef.current = overlayVisible
    if (overlayVisible && !prev) {
      overlayButtonRef.current?.focus({ preventScroll: true })
    } else if (!overlayVisible && prev) {
      setShieldVisible(true)
      if (shieldTimerRef.current !== null) clearTimeout(shieldTimerRef.current)
      shieldTimerRef.current = setTimeout(() => {
        shieldTimerRef.current = null
        setShieldVisible(false)
      }, CLICK_SHIELD_MS)
    }
  }, [overlayVisible])

  // 文字の領域は、新しい文字が届くたびに末尾（最新の行）を見せる
  useEffect(() => {
    const el = overlayTextRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [recognizedText, liveTranslatedText, overlayVisible])

  // 録音中の画面の本体のタップ。recording のときだけ止める（stopRecording は recording のときだけ止めるので、
  // 2回目以降のタップは何もしない）。starting の間は、許可のダイアログの操作の間の誤タップで取り消さないよう、何もしない
  const handleOverlayTap = (e: React.MouseEvent) => {
    e.stopPropagation()
    stopRecording()
  }

  // 下のボタン。recording なら停止（■）、starting なら取り消し（×）
  const handleOverlayButton = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (statusRef.current === 'recording') stopRecording()
    else if (statusRef.current === 'starting') handleCancelStarting()
  }

  // 盾はタップを受け止めるだけで、何もしない
  const handleShieldTap = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <main className="interpreter-page">
      <header className="interpreter-header" inert={underlayInert}>
        <h1 className="interpreter-title" onClick={handleBack} role="button" aria-label="トップ画面へ戻る">GoTalk</h1>
      </header>

      {selectedLanguages.length === 2 && (
        <div className="lang-flags-bar" inert={underlayInert}>
          {status !== 'recording' && (
            <p className="lang-flags-bar__guide">
              {FLAG_TAP_MESSAGES[selectedLanguages[0].id] ?? FLAG_TAP_MESSAGES['en']}
            </p>
          )}
          <div className="lang-flags-bar__flags">
            {([0, 1] as const).map(i => {
              const lang = selectedLanguages[i]
              const isThisRecording = status === 'recording' && recordingFlagIndex === i
              return (
                <button
                  key={lang.id}
                  type="button"
                  className={[
                    'lang-flags-bar__btn',
                    isThisRecording ? 'lang-flags-bar__btn--recording-static' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleFlagTap(i)}
                  disabled={!canTapFlag(i)}
                  aria-pressed={isThisRecording}
                  aria-label={isThisRecording ? `${lang.label}の録音を停止` : `${lang.label}で話す`}
                >
                  <img
                    className="lang-flags-bar__flag"
                    src={`/flags/${lang.id}.svg`}
                    alt={lang.label}
                  />
                </button>
              )
            })}
          </div>
          {status !== 'recording' && (
            <p className="lang-flags-bar__guide">
              {FLAG_TAP_MESSAGES[selectedLanguages[1].id] ?? FLAG_TAP_MESSAGES['en']}
            </p>
          )}
        </div>
      )}

      <div className="page-content" inert={underlayInert}>
        <div className={`source-card${isEditing ? ' source-card--editing' : ''}`} onClick={handleSourceCardTap}>
          {isEditing ? (
            <textarea
              ref={editRef}
              className="source-card__textarea"
              value={editValue}
              onChange={handleEditChange}
              onBlur={handleEditConfirm}
              onKeyDown={handleEditKeyDown}
              rows={1}
              aria-label="原文を編集"
            />
          ) : (
            <p className={`source-card__text${!recognizedText ? ' source-card__text--placeholder' : ''}`}>
              {recognizedText}
            </p>
          )}
          <button
            type="button"
            className={`source-card__edit${isEditing ? ' source-card__edit--editing' : ''}`}
            onClick={handleEditStart}
            disabled={!canEdit}
            aria-label={recognizedText ? '編集' : '入力'}
          >
            <EditIcon />
          </button>
        </div>

        {status !== 'recording' && (
          <div className="translation-card">
            <div className="translation-card__body">
              <div className="translation-card__main">
                <p
                  key={status === 'processing' ? processingMsgIdx : 'text'}
                  className={`translation-card__text${
                    status === 'processing' ? ' translation-card__text--processing' :
                    !translatedText ? ' translation-card__text--placeholder' : ''
                  }`}
                >
                  {status === 'processing' && processingLangs
                    ? [
                        `${TRANSLATING_MESSAGES[processingLangs[0]] ?? 'ただいま翻訳中です'}\n${TRANSLATING_MESSAGES[processingLangs[1]] ?? 'ただいま翻訳中です'}`,
                        `${PLEASE_WAIT_MESSAGES[processingLangs[0]] ?? 'しばらくお待ちください'}\n${PLEASE_WAIT_MESSAGES[processingLangs[1]] ?? 'しばらくお待ちください'}`,
                      ][processingMsgIdx]
                    : translatedText
                  }
                </p>
                <div className="back-translation-section">
                  <div className="back-translation-header">
                    <ChevronIcon />
                    <span>{backTranslationLabel}</span>
                  </div>
                  {backTranslation && (
                    <p className="back-translation-text">{backTranslation}</p>
                  )}
                </div>
              </div>

              {translatedText && (
                <button
                  type="button"
                  className={`speak-icon-button${status === 'speaking' ? ' speak-icon-button--speaking' : ''}`}
                  onClick={handleSpeak}
                  disabled={status !== 'ready'}
                  aria-label="発声する"
                >
                  <SpeakerIcon />
                </button>
              )}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="history-section">
            {history.map(item => (
              <div key={item.id} className="history-item">
                <div className="history-item__meta">
                  <span className="history-item__date">{item.date}</span>
                  <span className="history-item__time">{item.time}</span>
                </div>
                <div className="history-item__content">
                  <p className="history-item__source">{item.source}</p>
                  <p className="history-item__translation">{item.translation}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {errorMessage && (status === 'idle' || status === 'ready') && (
          <p className="error-text" role="alert">{errorMessage}</p>
        )}
      </div>

      {experiment.enabled && <div className="experiment-panel-wrap" inert={underlayInert}>
        <ExperimentPanel
          config={experiment}
          busy={status === 'starting' || status === 'recording' || status === 'stopping'}
          read={() => ({
            kind: 'audioSession',
            takenAt: new Date().toISOString(),
            effective: [...experiment.effective],
            // 表示が、押した後の診断の変化で変わらないように複製する
            diagnostics: JSON.parse(JSON.stringify(audioSession.getDiagnostics())),
          })}
        />
      </div>}

      {isEditing && (
        <div className="edit-confirm-shield" onMouseDown={handleEditShieldMouseDown} onClick={handleEditShieldTap} aria-hidden="true" />
      )}

      {overlayVisible && (
        <div
          className="recording-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={recordingGuide}
          onClick={handleOverlayTap}
        >
          <p className="recording-overlay__guide">{recordingGuide}</p>
          <div className="recording-overlay__text" ref={overlayTextRef} aria-live="polite">
            <p className="recording-overlay__source">{recognizedText}</p>
            {liveTranslatedText && (
              <p className="recording-overlay__live-translation">{liveTranslatedText}</p>
            )}
          </div>
          <div
            className={`recording-overlay__bars${isTextFlowing ? ' recording-overlay__bars--flowing' : ''}`}
            aria-hidden="true"
          >
            {[0, 1, 2, 3, 4].map(i => <span key={i} className="recording-overlay__bar" />)}
          </div>
          <button
            ref={overlayButtonRef}
            type="button"
            className="recording-overlay__button"
            onClick={handleOverlayButton}
            aria-label={overlayButtonLabel}
          >
            {status === 'recording' ? <StopIcon /> : <CancelIcon />}
          </button>
        </div>
      )}

      {shieldVisible && (
        <div className="recording-click-shield" onClick={handleShieldTap} aria-hidden="true" />
      )}
    </main>
  )
}

function EditIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// textarea の高さを中の文字に合わせる
function fitEditHeight(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" />
    </svg>
  )
}

function CancelIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
