import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import './InterpreterPage.css'

type InterpreterStatus = 'idle' | 'recording' | 'processing' | 'ready' | 'speaking'

interface InterpreterPageProps {
  selectedLanguages: Language[]
  onBack: () => void
  pendingAudio?: Blob
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

const LANGUAGE_UNCLEAR_MESSAGES: Record<string, string> = {
  'ja':    '言語不明、もう一度お話ください',
  'en':    'Language unclear. Please speak again.',
  'zh-CN': '语言不明，请再说一次',
  'zh-TW': '語言不明，請再說一次',
  'ko':    '언어를 알 수 없습니다. 다시 말씀해 주세요.',
  'th':    'ไม่ทราบภาษา กรุณาพูดอีกครั้ง',
  'vi':    'Không rõ ngôn ngữ. Vui lòng nói lại.',
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

interface SpeechRecognitionEvent {
  readonly results: { readonly length: number; readonly [i: number]: { readonly [j: number]: { readonly transcript: string } } }
}

interface SpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export default function InterpreterPage({ selectedLanguages, onBack, pendingAudio }: InterpreterPageProps) {
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

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const userStoppedRef = useRef(false)
  const isInterpretingRef = useRef(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const recordingLangRef = useRef<Language | null>(null)
  const speechRecognitionRef = useRef<SpeechRecognition | null>(null)
  const hasLiveTranscriptRef = useRef(false)
  const recognizedTextRef = useRef('')
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const rippleRefs = useRef<(HTMLDivElement | null)[]>([null, null, null])

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

  const handleLangMismatch = () => {
    const msgs = selectedLanguages
      .map(l => LANGUAGE_UNCLEAR_MESSAGES[l.id] ?? 'Language unclear. Please speak again.')
      .join('\n\n')
    setErrorMessage(msgs)
    setTranslatedText('')
    setBackTranslation('')
    setStatus('idle')
  }

  const callInterpretApi = async (audioBlob: Blob) => {
    if (isInterpretingRef.current) return
    isInterpretingRef.current = true
    setStatus('processing')
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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const res = await fetch('/api/interpret', { method: 'POST', body: formData, signal: controller.signal })

      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      if (!hasLiveTranscriptRef.current) { recognizedTextRef.current = data.text; setRecognizedText(data.text) }
      hasLiveTranscriptRef.current = false
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      setStatus('ready')
      addHistoryEntry(data.text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'AbortError'
        ? '通信がタイムアウトしました。もう一度お試しください。'
        : e instanceof Error ? e.message : '処理に失敗しました'
      setErrorMessage(msg)
      setStatus('idle')
    } finally {
      clearTimeout(timer)
      isInterpretingRef.current = false
    }
  }

  // テキスト編集後の再翻訳にのみ使用
  const callTranslateApi = async (text: string) => {
    setStatus('processing')
    setErrorMessage('')
    const srcLang = recordingLangRef.current ?? selectedLanguages[0]
    const tgtLang = srcLang.id === selectedLanguages[0].id ? selectedLanguages[1] : selectedLanguages[0]
    setProcessingLangs([srcLang.id, tgtLang.id])
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
        signal: controller.signal,
      })
      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      setStatus('ready')
      addHistoryEntry(text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'AbortError'
        ? '通信がタイムアウトしました。もう一度お試しください。'
        : e instanceof Error ? e.message : '翻訳に失敗しました'
      setErrorMessage(msg)
      setStatus('idle')
    } finally {
      clearTimeout(timer)
    }
  }

  // 録音中のリアルタイム翻訳（800ms デバウンス）
  useEffect(() => {
    if (status !== 'recording' || !recognizedText) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
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
      } catch { /* AbortError やネットワークエラーは無視 */ }
    }, 800)
    return () => { clearTimeout(timer); controller.abort() }
  }, [recognizedText, status, selectedLanguages])

  useEffect(() => {
    if (status !== 'processing') return
    const id = setInterval(() => setProcessingMsgIdx(i => (i + 1) % 2), 1200)
    return () => { clearInterval(id); setProcessingMsgIdx(0) }
  }, [status])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioRef.current?.pause()
      speechRecognitionRef.current?.stop()
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      audioContextRef.current?.close()
    }
  }, [])

  const callInterpretApiRef = useRef(callInterpretApi)

  useEffect(() => {
    if (!pendingAudio) return
    const audio = pendingAudio
    const timer = setTimeout(() => { void callInterpretApiRef.current(audio) }, 0)
    return () => clearTimeout(timer)
  }, [pendingAudio])

  const startRecording = async (lang: Language, flagIndex: 0 | 1) => {
    const mimeType = getSupportedMimeType()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      audioChunksRef.current = []
      userStoppedRef.current = false
      isInterpretingRef.current = false
      hasLiveTranscriptRef.current = false
      recordingLangRef.current = lang

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        if (!userStoppedRef.current) return
        const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' })
        callInterpretApi(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setRecordingFlagIndex(flagIndex)
      setStatus('recording')

      try {
        const audioCtx = new AudioContext()
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        audioContextRef.current = audioCtx
        analyserRef.current = analyser

        const timeData = new Uint8Array(analyser.fftSize)
        let startTime: number | null = null
        const DURATION = 1500
        const COUNT = 3

        const tick = (now: number) => {
          if (startTime === null) startTime = now
          analyser.getByteTimeDomainData(timeData)
          let sum = 0
          for (let j = 0; j < timeData.length; j++) {
            const v = (timeData[j] - 128) / 128
            sum += v * v
          }
          const amplitude = Math.min(1, Math.sqrt(sum / timeData.length) * 8)
          const elapsed = now - startTime
          rippleRefs.current.forEach((el, ri) => {
            if (!el) return
            const phase = ((elapsed / DURATION) + ri / COUNT) % 1
            el.style.transform = `scale(${phase})`
            el.style.opacity = String((1 - phase) * amplitude * 0.75)
          })
          rafIdRef.current = requestAnimationFrame(tick)
        }
        rafIdRef.current = requestAnimationFrame(tick)
      } catch { /* AudioContext 非対応環境では波紋なし */ }

      const RecognitionCtor = getSpeechRecognitionCtor()
      if (RecognitionCtor) {
        const recognition = new RecognitionCtor()
        recognition.lang = lang.speechCode
        recognition.interimResults = true
        recognition.continuous = true
        recognition.onresult = (event) => {
          let transcript = ''
          for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript
          }
          hasLiveTranscriptRef.current = true
          recognizedTextRef.current = transcript
          setRecognizedText(transcript)
        }
        recognition.onerror = () => {}
        recognition.onend = () => {
          if (mediaRecorderRef.current?.state === 'recording') {
            try { recognition.start() } catch { /* ignore */ }
          }
        }
        try {
          recognition.start()
          speechRecognitionRef.current = recognition
        } catch { /* SpeechRecognition unavailable, Whisper handles final result */ }
      }
    } catch {
      setErrorMessage('マイクへのアクセスが許可されていません')
      setStatus('idle')
      setRecordingFlagIndex(null)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== 'recording') return
    userStoppedRef.current = true
    speechRecognitionRef.current?.stop()
    speechRecognitionRef.current = null
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    rippleRefs.current.forEach(el => {
      if (el) { el.style.transform = 'scale(0)'; el.style.opacity = '0' }
    })
    audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
    setRecordingFlagIndex(null)
    setStatus('processing')
    mediaRecorderRef.current.stop()
  }

  const handleFlagTap = (flagIndex: 0 | 1) => {
    if (status === 'recording') {
      if (recordingFlagIndex === flagIndex) stopRecording()
      return
    }
    if (status !== 'idle' && status !== 'ready') return
    recognizedTextRef.current = ''
    setRecognizedText('')
    setLiveTranslatedText('')
    setTranslatedText('')
    setTtsText('')
    setBackTranslation('')
    setErrorMessage('')
    startRecording(selectedLanguages[flagIndex], flagIndex)
  }

  const handleSpeak = async () => {
    setStatus('speaking')
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText }),
      })
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      const cleanup = () => {
        URL.revokeObjectURL(url)
        audioRef.current = null
        setStatus('ready')
      }
      audio.onended = cleanup
      audio.onerror = cleanup
      await audio.play()
    } catch {
      setStatus('ready')
    }
  }

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
    recognizedTextRef.current = trimmed
    setRecognizedText(trimmed)
    callTranslateApi(trimmed)
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

  const canEdit = !!recognizedText && !isEditing && status !== 'recording' && status !== 'processing'

  const canTapFlag = (i: 0 | 1): boolean => {
    if (status === 'processing' || status === 'speaking') return false
    if (status === 'recording') return recordingFlagIndex === i
    return true
  }

  return (
    <main className="interpreter-page">
      <header className="interpreter-header">
        <h1 className="interpreter-title" onClick={onBack} role="button" aria-label="トップ画面へ戻る">GoTalk</h1>
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
                  disabled={status === 'processing' || status === 'speaking'}
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

        {errorMessage && status === 'idle' && (
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
