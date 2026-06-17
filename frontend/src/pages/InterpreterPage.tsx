import { useState, useEffect, useRef } from 'react'
import './InterpreterPage.css'

type InterpreterStatus = 'idle' | 'recording' | 'processing' | 'ready' | 'speaking'
type Speaker = 'me' | 'them'

const LANG_CODES: Record<string, string> = {
  '日本語': 'ja-JP',
  'ไทย': 'th-TH',
}

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
  myLanguage: string
  theirLanguage: string
  onBack: () => void
}

export default function InterpreterPage({ myLanguage, theirLanguage, onBack }: InterpreterPageProps) {
  const [status, setStatus] = useState<InterpreterStatus>('idle')
  const [speaker, setSpeaker] = useState<Speaker>('me')
  const [recognizedText, setRecognizedText] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const speakerLabel = speaker === 'me' ? 'あなた' : '相手'
  const speakerLanguage = speaker === 'me' ? myLanguage : theirLanguage
  const sourceLang = speaker === 'me' ? myLanguage : theirLanguage
  const targetLang = speaker === 'me' ? theirLanguage : myLanguage

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      recognitionRef.current?.abort()
    }
  }, [])

  const startRecognition = () => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      console.error('Web Speech API is not supported in this browser.')
      return
    }

    recognitionRef.current?.abort()
    setRecognizedText('')

    const recognition = new Ctor()
    recognition.lang = LANG_CODES[speakerLanguage] ?? 'ja-JP'
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setStatus('recording')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      setRecognizedText(final || interim)
      if (final) {
        setStatus('ready')
      }
    }

    // Fires when speech ends; final result arrives shortly after via onresult
    recognition.onspeechend = () => {
      setStatus(prev => (prev === 'recording' ? 'processing' : prev))
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('STT error:', event.error)
      setStatus('idle')
    }

    // If processing never got a final result (e.g. no speech), reset to idle
    recognition.onend = () => {
      setStatus(prev => (prev === 'processing' ? 'idle' : prev))
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  // STT hook point: Web Speech API
  const handleMicPress = () => {
    if (status === 'idle') {
      startRecognition()
    } else if (status === 'recording') {
      // stop() triggers finalization; abort() discards — use stop() to get the result
      recognitionRef.current?.stop()
    }
  }

  // TTS hook point: replace body to trigger real speech synthesis
  const handleSpeak = () => {
    setStatus('speaking')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setStatus('idle'), 2000)
  }

  const handleRetry = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    startRecognition()
  }

  const handleSwitchSpeaker = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    recognitionRef.current?.abort()
    setSpeaker(prev => (prev === 'me' ? 'them' : 'me'))
    setStatus('idle')
    setRecognizedText('')
  }

  return (
    <main className="interpreter-page">
      <header className="interpreter-header">
        <button
          type="button"
          className="back-button"
          onClick={onBack}
          aria-label="言語選択に戻る"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M12 16l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <div className="language-pair">
          <span className="language-pair__lang">{myLanguage}</span>
          <span className="language-pair__arrow" aria-hidden="true">⇄</span>
          <span className="language-pair__lang">{theirLanguage}</span>
        </div>

        <div className="header-spacer" aria-hidden="true" />
      </header>

      <section className="speaker-section">
        <p className="speaker-section__heading">現在の話者</p>
        <div className="speaker-badge" aria-live="polite">
          <span className="speaker-badge__name">{speakerLabel}</span>
          <span className="speaker-badge__lang">{speakerLanguage}</span>
        </div>
        <button
          type="button"
          className="switch-button"
          onClick={handleSwitchSpeaker}
          disabled={status !== 'idle'}
        >
          話者を切り替える
        </button>
      </section>

      {status === 'ready' ? (
        <section className="result-section">
          <div className="result-card" aria-live="polite">
            <div className="result-row">
              <span className="result-row__label">{sourceLang} — 認識結果</span>
              <p className="result-row__text">{recognizedText}</p>
            </div>
            <div className="result-divider" />
            <div className="result-row">
              <span className="result-row__label">{targetLang} — 翻訳</span>
              <p className="result-row__text result-row__text--placeholder">未実装</p>
            </div>
            <div className="result-divider" />
            <div className="result-row">
              <span className="result-row__label">逆翻訳</span>
              <p className="result-row__text result-row__text--placeholder">未実装</p>
            </div>
          </div>

          <div className="action-buttons">
            <button type="button" className="speak-button" onClick={handleSpeak}>
              <SpeakerIcon />
              発話する
            </button>
            <button type="button" className="retry-button" onClick={handleRetry}>
              話し直す
            </button>
          </div>
        </section>
      ) : (
        <section className="mic-section">
          {(status === 'idle' || status === 'recording') && (
            <button
              type="button"
              className={`mic-button${status === 'recording' ? ' mic-button--recording' : ''}`}
              onClick={handleMicPress}
              aria-label={status === 'recording' ? '録音を停止する' : 'マイクをタップして話す'}
              aria-pressed={status === 'recording'}
            >
              <MicIcon />
            </button>
          )}

          {status === 'processing' && (
            <div className="status-indicator status-indicator--processing" role="status">
              <span className="spinner" aria-hidden="true" />
            </div>
          )}

          {status === 'speaking' && (
            <div className="status-indicator status-indicator--speaking" role="status">
              <SpeakerIcon />
            </div>
          )}

          <p className="mic-hint" aria-live="polite">
            {status === 'idle' && 'タップして話す'}
            {status === 'recording' && '録音中'}
            {status === 'processing' && '認識中...'}
            {status === 'speaking' && '発話中'}
          </p>

          {status === 'recording' && recognizedText && (
            <p className="interim-text" aria-live="polite">{recognizedText}</p>
          )}
        </section>
      )}
    </main>
  )
}

function MicIcon() {
  return (
    <svg className="mic-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
