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

const LANGUAGE_UNCLEAR_MESSAGES: Record<string, string> = {
  'ja':    '言語不明、もう一度お話ください',
  'en':    'Language unclear. Please speak again.',
  'zh-CN': '语言不明，请再说一次',
  'zh-TW': '語言不明，請再說一次',
  'ko':    '언어를 알 수 없습니다. 다시 말씀해 주세요.',
  'th':    'ไม่ทราบภาษา กรุณาพูดอีกครั้ง',
}

const HISTORY_COLLAPSED_COUNT = 5

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

export default function InterpreterPage({ selectedLanguages, onBack, pendingAudio }: InterpreterPageProps) {
  const [status, setStatus] = useState<InterpreterStatus>('idle')
  const [recognizedText, setRecognizedText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [backTranslation, setBackTranslation] = useState('')
  const [targetLangId, setTargetLangId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const userStoppedRef = useRef(false)
  const isInterpretingRef = useRef(false)
  const editRef = useRef<HTMLTextAreaElement>(null)

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
    setHistory(prev => [{
      id: String(Date.now()),
      date: `${now.getMonth() + 1}月${now.getDate()}日`,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
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

    const formData = new FormData()
    formData.append('audio', audioBlob, `recording.${ext}`)
    formData.append('myLanguage', JSON.stringify({ id: selectedLanguages[0].id, label: selectedLanguages[0].label }))
    formData.append('theirLanguage', JSON.stringify({ id: selectedLanguages[1].id, label: selectedLanguages[1].label }))
    formData.append('speaker', '')

    try {
      const res = await fetch('/api/interpret', { method: 'POST', body: formData })

      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      setRecognizedText(data.text)
      setTranslatedText(data.translatedText)
      setBackTranslation(data.backTranslation)
      setTargetLangId(data.targetLanguage)
      setStatus('ready')
      addHistoryEntry(data.text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '処理に失敗しました')
      setStatus('idle')
    } finally {
      isInterpretingRef.current = false
    }
  }

  // テキスト編集後の再翻訳にのみ使用
  const callTranslateApi = async (text: string) => {
    setStatus('processing')
    setErrorMessage('')
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
      })
      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTranslatedText(data.translatedText)
      setBackTranslation(data.backTranslation)
      setTargetLangId(data.targetLanguage)
      setStatus('ready')
      addHistoryEntry(text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '翻訳に失敗しました')
      setStatus('idle')
    }
  }

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioRef.current?.pause()
    }
  }, [])

  useEffect(() => {
    if (!pendingAudio) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    callInterpretApi(pendingAudio)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startRecording = async () => {
    const mimeType = getSupportedMimeType()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      audioChunksRef.current = []
      userStoppedRef.current = false
      isInterpretingRef.current = false

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
      setStatus('recording')
    } catch {
      setErrorMessage('マイクへのアクセスが許可されていません')
      setStatus('idle')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== 'recording') return
    userStoppedRef.current = true
    setStatus('processing')
    mediaRecorderRef.current.stop()
  }

  const handleMicPress = () => {
    if (status === 'idle' || status === 'ready') {
      setRecognizedText('')
      setErrorMessage('')
      startRecording()
    } else if (status === 'recording') {
      stopRecording()
    }
  }

  const handleSpeak = async () => {
    setStatus('speaking')
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: translatedText }),
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

  const isMicActive = status === 'idle' || status === 'ready' || status === 'recording'
  const canEdit = !!recognizedText && !isEditing && status !== 'recording' && status !== 'processing'
  const visibleHistory = historyExpanded ? history : history.slice(0, HISTORY_COLLAPSED_COUNT)
  const hasMoreHistory = history.length > HISTORY_COLLAPSED_COUNT

  return (
    <main className="interpreter-page">
      <header className="interpreter-header">
        <h1 className="interpreter-title" onClick={onBack} role="button" aria-label="トップ画面へ戻る">GoTalk</h1>
      </header>

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

        <div className="translation-card">
          <div className="translation-card__body">
            <div className="translation-card__main">
              <p className={`translation-card__text${!translatedText ? ' translation-card__text--placeholder' : ''}`}>
                {translatedText}
              </p>
              <div className="back-translation-section">
                <div className="back-translation-header">
                  <ChevronIcon />
                  <span>AI逆翻訳</span>
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
                disabled={status === 'processing' || status === 'recording' || status === 'speaking'}
                aria-label="発声する"
              >
                <SpeakerIcon />
              </button>
            )}
          </div>
        </div>

        {history.length > 0 && (
          <div className="history-section">
            {visibleHistory.map(item => (
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
            {hasMoreHistory && (
              <button
                type="button"
                className="history-expand-button"
                onClick={() => setHistoryExpanded(prev => !prev)}
                aria-label={historyExpanded ? '履歴を閉じる' : '履歴をすべて表示'}
              >
                {historyExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
              </button>
            )}
          </div>
        )}

        {errorMessage && status === 'idle' && (
          <p className="error-text" role="alert">{errorMessage}</p>
        )}
      </div>

      <footer className="mic-footer">
        {status === 'processing' ? (
          <div className="mic-circle-button mic-circle-button--processing" role="status" aria-label="処理中">
            <span className="spinner" aria-hidden="true" />
          </div>
        ) : (
          <button
            type="button"
            className={[
              'mic-circle-button',
              status === 'recording' ? 'mic-circle-button--recording' : '',
            ].filter(Boolean).join(' ')}
            onClick={isMicActive ? handleMicPress : undefined}
            disabled={!isMicActive}
            aria-pressed={status === 'recording'}
            aria-label={status === 'recording' ? '停止して翻訳' : '話す'}
          >
            {status === 'recording' ? <StopIcon /> : <MicIcon />}
          </button>
        )}
      </footer>
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

function ChevronDownIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronUpIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 15l-6-6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 10a7 7 0 0014 0" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <line x1="9" y1="21" x2="15" y2="21" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
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
