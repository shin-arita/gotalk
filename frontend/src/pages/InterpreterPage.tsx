import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import { LANGUAGES } from '../languages'
import './InterpreterPage.css'

type InterpreterStatus = 'idle' | 'recording' | 'processing' | 'ready' | 'speaking'

// Chrome uses webkit prefix; declare so TypeScript doesn't complain
declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognition
  }
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

interface InterpreterPageProps {
  selectedLanguages: Language[]
  onBack: () => void
  pendingText?: string
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

const showSttLog = new URLSearchParams(window.location.search).get('debug') === 'stt'

const HISTORY_COLLAPSED_COUNT = 5

export default function InterpreterPage({ selectedLanguages, onBack, pendingText }: InterpreterPageProps) {
  const [status, setStatus] = useState<InterpreterStatus>('idle')
  const [recognizedText, setRecognizedText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [backTranslation, setBackTranslation] = useState('')
  const [sourceLangId, setSourceLangId] = useState('')
  const [targetLangId, setTargetLangId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [sttLog, setSttLog] = useState<string[]>([])
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const recognizedTextRef = useRef<string>('')
  const translateCalledRef = useRef(false)
  const speakingRef = useRef(false)
  const userStoppedRef = useRef(false)
  const accumulatedTextRef = useRef('')
  // Alternates between 0 and 1 after each completed TTS; determines which lang to use for STT
  const currentLangIdxRef = useRef(0)
  const editRef = useRef<HTMLTextAreaElement>(null)

  const targetLang = LANGUAGES.find(l => l.id === targetLangId)

  // textarea のフォーカスと高さ自動調整
  useEffect(() => {
    if (!isEditing || !editRef.current) return
    const el = editRef.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [isEditing])

  const callTranslateApi = async (text: string) => {
    setStatus('processing')
    setErrorMessage('')
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTranslatedText(data.translatedText)
      setBackTranslation(data.backTranslation)
      setSourceLangId(data.sourceLanguage)
      setTargetLangId(data.targetLanguage)
      setStatus('ready')

      const now = new Date()
      const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      setHistory(prev => [{
        id: String(Date.now()),
        date: dateStr,
        time: timeStr,
        source: text,
        translation: data.translatedText,
        backTranslation: data.backTranslation,
        sourceLangId: data.sourceLanguage,
        targetLangId: data.targetLanguage,
      }, ...prev])
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '翻訳に失敗しました')
      setStatus('idle')
    }
  }

  const addSttLog = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23)
    console.log(`[STT] ${msg}`)
    setSttLog(prev => [`${ts} ${msg}`, ...prev])
  }

  useEffect(() => {
    return () => {
      speakingRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      recognitionRef.current?.abort()
      window.speechSynthesis?.cancel()
    }
  }, [])

  // トップ画面で録音した原文を受け取ったら即翻訳する
  useEffect(() => {
    if (!pendingText) return
    setRecognizedText(pendingText)
    recognizedTextRef.current = pendingText
    callTranslateApi(pendingText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startRecognition = () => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      console.error('Web Speech API is not supported in this browser.')
      return
    }

    recognitionRef.current?.abort()
    setRecognizedText('')
    recognizedTextRef.current = ''
    translateCalledRef.current = false
    userStoppedRef.current = false
    accumulatedTextRef.current = ''
    setSttLog([])

    const sttLang = selectedLanguages[currentLangIdxRef.current]?.speechCode ?? 'ja-JP'

    const recognition = new Ctor()
    recognition.lang = sttLang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      addSttLog(`onstart lang=${sttLang}`)
      setStatus('recording')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = ''
      let interim = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) final += result[0].transcript
        else interim += result[0].transcript
      }
      addSttLog(`onresult final="${final}" interim="${interim}"`)
      // Show finalized + in-progress text; prepend any text from before auto-restart
      const sessionText = final + interim
      const fullText = accumulatedTextRef.current
        ? accumulatedTextRef.current + ' ' + sessionText
        : sessionText
      setRecognizedText(fullText)
      recognizedTextRef.current = fullText
    }

    recognition.onspeechend = () => {
      addSttLog('onspeechend')
    }

    recognition.onaudioend = () => {
      addSttLog('onaudioend')
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      addSttLog(`onerror error=${event.error}`)
      // Mark as done so onend (which always fires after onerror) skips restart/translate
      translateCalledRef.current = true
      setStatus('idle')
    }

    recognition.onend = () => {
      addSttLog('onend')
      if (translateCalledRef.current) return  // onerror already handled, or translate already called
      if (!userStoppedRef.current) {
        // Auto-end by browser (e.g. Safari silence detection) — keep recording by restarting
        accumulatedTextRef.current = recognizedTextRef.current
        addSttLog('auto-end: restarting')
        try {
          recognition.start()
        } catch (e) {
          addSttLog(`restart failed: ${String(e)}`)
          setStatus('idle')
        }
        return
      }
      // User explicitly stopped
      if (recognizedTextRef.current) {
        translateCalledRef.current = true
        callTranslateApi(recognizedTextRef.current)
      } else {
        setStatus('idle')
      }
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  const handleMicPress = () => {
    if (status === 'idle' || status === 'ready') {
      startRecognition()
    } else if (status === 'recording') {
      addSttLog('manual stop')
      userStoppedRef.current = true
      setStatus('processing')
      recognitionRef.current?.stop()
    }
  }

  // iPhone Safari では onend / onerror が安定して発火しないため、
  // フォールバックタイマーで必ず idle へ戻す
  const TTS_FALLBACK_MS = 3000

  const handleSpeak = () => {
    if (!window.speechSynthesis) {
      setStatus('idle')
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)
    speakingRef.current = true

    // onend / onerror / fallback timer のいずれかが最初に実行された時だけ idle へ遷移する。
    // speakingRef が false の場合（後発の遅延イベント、または呼び出し元が既に状態を変えた場合）は何もしない。
    const resetToIdle = () => {
      if (!speakingRef.current) return
      speakingRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      // TTS完了後は逆側の言語に切り替え（次のターンに備える）
      currentLangIdxRef.current = 1 - currentLangIdxRef.current
      setStatus('ready')
    }

    // TTS言語はAPIレスポンスの targetLanguage から取得
    const ttsLang = targetLang?.speechCode
      ?? selectedLanguages[1 - currentLangIdxRef.current]?.speechCode
      ?? 'ja-JP'
    const u = new SpeechSynthesisUtterance(translatedText)
    u.lang = ttsLang

    u.onstart = () => console.log('[TTS] onstart')
    u.onend = () => {
      console.log('[TTS] onend')
      resetToIdle()
    }
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      console.log(`[TTS] onerror error=${e.error}`)
      resetToIdle()
    }

    // speak() はユーザージェスチャーの同期コード内で最初に呼ぶ
    // (iPhone Safari はジェスチャー信頼チェーンが途切れると無音キャンセルする)
    window.speechSynthesis.speak(u)
    setStatus('speaking')
    timerRef.current = setTimeout(resetToIdle, TTS_FALLBACK_MS)
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
    if (!trimmed) return
    if (trimmed === recognizedText) return
    setRecognizedText(trimmed)
    recognizedTextRef.current = trimmed
    callTranslateApi(trimmed)
  }

  const handleEditChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditValue(e.target.value)
    // textarea の高さを内容に合わせる
    e.target.style.height = 'auto'
    e.target.style.height = `${e.target.scrollHeight}px`
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleEditConfirm()
    }
    if (e.key === 'Escape') {
      setIsEditing(false)
    }
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
        {/* 原文カード */}
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
              {recognizedText || (status === 'recording' ? '録音中...' : 'ここに話した言葉が表示されます')}
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

        {/* 翻訳カード */}
        <div className="translation-card">
          <div className="translation-card__body">
            <div className="translation-card__main">
              <p className={`translation-card__text${!translatedText ? ' translation-card__text--placeholder' : ''}`}>
                {status === 'processing'
                  ? '翻訳中...'
                  : translatedText || '翻訳文がここに表示されます'}
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

        {/* 履歴 */}
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

        {showSttLog && (
          <section className="stt-log">
            <p className="stt-log__title">STT log</p>
            <div className="stt-log__body">
              {sttLog.length === 0
                ? <span className="stt-log__empty">（なし）</span>
                : sttLog.map((line, i) => <div key={i}>{line}</div>)
              }
            </div>
          </section>
        )}
      </div>

      {/* マイクフッター */}
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
      <path
        d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
      <path
        d="M5 10a7 7 0 0014 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
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
