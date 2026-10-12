import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import { API_TIMEOUT_MS, ApiError, MAX_INTERPRET_AUDIO_BYTES, apiErrorCode, apiErrorFromResponse, isTooLongForTts, logApiError, messageKeyForCode, messageKeyForError } from '../api'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import { useAudioSession } from '../hooks/useAudioSession'
import type { AudioSessionAbortReason, AudioSessionStartFailure } from '../hooks/useAudioSession'
import './InterpreterPage.css'

// 画面全体の状態（docs/speech-flow.md）。状態は画面だけが持つ
// idle: 何もしていない / starting: マイクを開いて録音を始めている途中 / recording: 録音の成立の後、話している /
// stopping: 利用者が止めて、録音の最後のデータを待っている / processing: 文字起こしと翻訳を待っている /
// ready: 翻訳の結果が出ている / speaking: 読み上げている / error: 失敗の後の片付けの途中（短い間）
type InterpreterStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'processing' | 'ready' | 'speaking' | 'error'

interface InterpreterPageProps {
  selectedLanguages: Language[]
  onBack: () => void
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

const FLAG_FINISH_MESSAGES: Record<string, string> = {
  'ja':    '話し終わったらもう一度国旗をタップして終了してください。',
  'en':    'Tap the flag again when you are finished.',
  'zh-CN': '说完后再次点击国旗结束。',
  'zh-TW': '說完後再次點擊國旗結束。',
  'ko':    '말이 끝나면 국기를 다시 탭하여 종료하세요.',
  'th':    'เมื่อพูดเสร็จแล้ว แตะธงอีกครั้งเพื่อสิ้นสุด',
  'vi':    'Khi nói xong, nhấn vào cờ một lần nữa để kết thúc.',
}

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

export default function InterpreterPage({ selectedLanguages, onBack }: InterpreterPageProps) {
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

  const backTranslationLabel = selectedLanguages.length === 2
    ? `${BACK_TRANSLATION_LABELS[selectedLanguages[0].id] ?? '逆翻訳'} / ${BACK_TRANSLATION_LABELS[selectedLanguages[1].id] ?? '逆翻訳'}`
    : '逆翻訳'

  // 非同期の callback の中では、React の状態ではなく、これらの ref でその時点の最新の値を読む
  const statusRef = useRef<InterpreterStatus>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  // 読み上げの番号（/api/tts の問い合わせと <audio> の再生）。今有効な番号を1つだけ持つ
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
  const rippleRefs = useRef<(HTMLDivElement | null)[]>([null, null, null])

  // 録音のセッション。状態は持たず、録音の成立、最後のデータ、失敗を callback で知らせる
  const audioSession = useAudioSession({
    onRecordingStarted: () => handleRecordingStarted(),
    onStartFailed: (failure, reason) => handleStartFailed(failure, reason),
    onTranscript: (transcript) => {
      hasLiveTranscriptRef.current = true
      recognizedTextRef.current = transcript
      setRecognizedText(transcript)
    },
    onLevel: (amplitude, elapsedMs) => updateRipples(amplitude, elapsedMs),
    onRecordingStopped: (blob) => handleRecordingStopped(blob),
    onRecorderError: () => handleRecorderError(),
    isRecordingStatus: () => statusRef.current === 'recording',
  })

  // 画面の状態を変える。状態は画面だけが持つ（statusRef は、非同期の callback から最新の値を読むため）
  const changeStatus = (next: InterpreterStatus) => {
    statusRef.current = next
    setStatus(next)
    audioSession.logEvent(`status:${next}`)
  }

  useEffect(() => {
    if (!isEditing || !editRef.current) return
    const el = editRef.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [isEditing])

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

  const updateRipples = (amplitude: number, elapsedMs: number) => {
    const DURATION = 1500
    const COUNT = 3
    rippleRefs.current.forEach((el, ri) => {
      if (!el) return
      const phase = ((elapsedMs / DURATION) + ri / COUNT) % 1
      el.style.transform = `scale(${phase})`
      el.style.opacity = String((1 - phase) * amplitude * 0.75)
    })
  }

  const resetRipples = () => {
    rippleRefs.current.forEach(el => {
      if (el) { el.style.transform = 'scale(0)'; el.style.opacity = '0' }
    })
  }

  // 読み上げを止める（<audio> を止めて object URL を解放し、/api/tts の問い合わせも止める）。冪等
  const stopSpeaking = () => {
    activeTtsIdRef.current = null
    const controller = ttsControllerRef.current
    ttsControllerRef.current = null
    controller?.abort()
    const audio = audioRef.current
    audioRef.current = null
    if (audio) {
      audio.onended = null
      audio.onerror = null
      try { audio.pause() } catch { /* 止める処理の例外は捨てる */ }
    }
    const url = audioUrlRef.current
    audioUrlRef.current = null
    if (url) URL.revokeObjectURL(url)
  }

  // 録音の成立（マイク ON）
  const handleRecordingStarted = () => {
    if (statusRef.current !== 'starting') {
      // 中断はセッションを先に無効にするので、ここには来ない。来た場合は録音を片付ける
      void audioSession.abort('error')
      return
    }
    changeStatus('recording')
  }

  // 録音の成立までの失敗。hook が資源を片付けた後に呼ばれる
  const handleStartFailed = (failure: AudioSessionStartFailure, reason: string) => {
    console.warn('[GoTalk] microphone error', { reason })
    changeStatus('error')
    showMessage(failure)
    setRecordingFlagIndex(null)
    changeStatus('idle')
  }

  // 録音の成立の後の MediaRecorder の onerror。hook が中断の片付け（理由 error）をした後に呼ばれる
  const handleRecorderError = () => {
    changeStatus('error')
    resetRipples()
    showMessage('recording_start_failed')
    setRecordingFlagIndex(null)
    changeStatus('idle')
  }

  // 利用者の停止で、マイク OFF が成立した後に呼ばれる。ここで初めて processing に進み、Backend に送る
  const handleRecordingStopped = (blob: Blob) => {
    if (statusRef.current !== 'stopping') return
    setRecordingFlagIndex(null)
    void callInterpretApi(blob)
  }

  const stopRecording = () => {
    if (statusRef.current !== 'recording') return
    changeStatus('stopping')
    resetRipples()
    audioSession.stop()
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
    const lang = selectedLanguages[flagIndex]
    recordingLangRef.current = lang
    setRecordingFlagIndex(flagIndex)
    changeStatus('starting')
    void audioSession.start(lang.speechCode)
  }

  const handleSpeak = async () => {
    if (statusRef.current !== 'ready') return
    setErrorMessage('')
    // 上限を超える翻訳の結果は読み上げない（翻訳の結果の表示はそのまま）
    if (isTooLongForTts(ttsText)) {
      showMessage('tts_too_long')
      return
    }
    // マイクを開いている間に <audio> を鳴らさない。ready ではマイク OFF のはずなので、残っていれば異常として記録し、
    // 片付けが終わるのを待ってから鳴らす（ここで吸収して終わりにせず、片付けの不具合として直すこと）
    if (audioSession.hasActiveSession()) {
      audioSession.logEvent('unexpected_active_audio_session_before_tts')
      console.warn('[GoTalk] unexpected_active_audio_session_before_tts')
      await audioSession.abort('error')
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
      if (activeTtsIdRef.current !== ttsId) return
      if (!res.ok) {
        // 利用者に知らせるべきエラー（混み合っている、など）だけを表示する。
        // input_too_large は、Frontend と Backend の文字数の判定がずれた場合などへの備え
        const code = await apiErrorCode(res)
        const messageKey = code === 'input_too_large' ? 'tts_too_long' : messageKeyForCode(code)
        throw new ApiError(messageKey, '/api/tts', res.status, code)
      }
      const blob = await res.blob()
      if (activeTtsIdRef.current !== ttsId) return
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      const finish = () => {
        if (activeTtsIdRef.current !== ttsId) return
        stopSpeaking()
        changeStatus('ready')
      }
      audio.onended = finish
      audio.onerror = finish
      await audio.play()
    } catch (e) {
      // 止めた読み上げ（hidden、pagehide など）の失敗は、画面に反映しない
      if (activeTtsIdRef.current !== ttsId) return
      // 表示する文言がないエラー（ネットワークのエラー、timeout など）は、ログにだけ残して何も表示しない
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

    if (current === 'starting' || current === 'recording' || current === 'stopping' || current === 'error') {
      void audioSession.abort(reason)
      resetRipples()
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
      || audioRef.current !== null
    if (hasLeftover) {
      audioSession.logEvent('unexpected_active_session_after_pageshow')
      console.warn('[GoTalk] unexpected_active_session_after_pageshow')
      void audioSession.abort('pagehide')
      abortTranslationRequest()
      stopSpeaking()
      resetRipples()
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
  useEffect(() => {
    interruptRef.current = interrupt
    pageShowRef.current = handlePageShow
  })

  useEffect(() => {
    const handlers = { interruptRef, pageShowRef }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') handlers.interruptRef.current('hidden')
    }
    const onPageHide = () => handlers.interruptRef.current('pagehide')
    const onPageShow = (e: PageTransitionEvent) => handlers.pageShowRef.current(e.persisted)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      handlers.interruptRef.current('unmount')
    }
  }, [])

  const handleEditStart = () => {
    if (!recognizedText) return
    setEditValue(recognizedText)
    setIsEditing(true)
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
    e.target.style.height = 'auto'
    e.target.style.height = `${e.target.scrollHeight}px`
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditConfirm() }
    if (e.key === 'Escape') setIsEditing(false)
  }

  const canEdit = !!recognizedText && !isEditing && (status === 'idle' || status === 'ready' || status === 'speaking')

  const canTapFlag = (i: 0 | 1): boolean => {
    if (status === 'recording') return recordingFlagIndex === i
    return status === 'idle' || status === 'ready'
  }

  return (
    <main className="interpreter-page">
      <header className="interpreter-header">
        <h1 className="interpreter-title" onClick={handleBack} role="button" aria-label="トップ画面へ戻る">GoTalk</h1>
      </header>

      {selectedLanguages.length === 2 && (
        <div className="lang-flags-bar">
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
                    isThisRecording ? 'lang-flags-bar__btn--recording' : '',
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
                  {isThisRecording && (
                    <>
                      <div className="flag-ripple" ref={el => { rippleRefs.current[0] = el }} />
                      <div className="flag-ripple" ref={el => { rippleRefs.current[1] = el }} />
                      <div className="flag-ripple" ref={el => { rippleRefs.current[2] = el }} />
                    </>
                  )}
                </button>
              )
            })}
          </div>
          {status !== 'recording' ? (
            <p className="lang-flags-bar__guide">
              {FLAG_TAP_MESSAGES[selectedLanguages[1].id] ?? FLAG_TAP_MESSAGES['en']}
            </p>
          ) : recordingFlagIndex !== null ? (
            <div className="lang-flags-bar__scroll-wrap">
              <p className="lang-flags-bar__scroll-text">
                {FLAG_FINISH_MESSAGES[selectedLanguages[recordingFlagIndex].id] ?? FLAG_FINISH_MESSAGES['en']}
              </p>
            </div>
          ) : null}
        </div>
      )}

      <div className="page-content">
        <div className="source-card">
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
            className="source-card__edit"
            onClick={handleEditStart}
            disabled={!canEdit}
            aria-label="編集"
          >
            <EditIcon />
          </button>
        </div>

        {status === 'recording' && liveTranslatedText && (
          <div className="live-translation-card">
            <p className="live-translation-card__text">{liveTranslatedText}</p>
          </div>
        )}

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

    </main>
  )
}

function EditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
