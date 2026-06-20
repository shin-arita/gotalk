import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import { LANGUAGES } from '../languages'
import './LanguageSelectPage.css'

interface Props {
  selectedLanguages: Language[]
  onSelectionChange: (langs: Language[]) => void
  onStart: (text: string) => void
}

export default function LanguageSelectPage({ selectedLanguages, onSelectionChange, onStart }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef<any>(null)
  const recognizedTextRef = useRef('')
  const accumulatedRef = useRef('')
  const userStoppedRef = useRef(false)

  const canStart = selectedLanguages.length === 2

  useEffect(() => {
    return () => recognitionRef.current?.abort()
  }, [])

  const handleCardTap = (lang: Language) => {
    if (isRecording) return
    const isSelected = selectedLanguages.some(l => l.id === lang.id)
    if (isSelected) {
      onSelectionChange(selectedLanguages.filter(l => l.id !== lang.id))
    } else if (selectedLanguages.length < 2) {
      onSelectionChange([...selectedLanguages, lang])
    }
  }

  const startSTT = () => {
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!Ctor) return

    recognitionRef.current?.abort()
    recognizedTextRef.current = ''
    accumulatedRef.current = ''
    userStoppedRef.current = false

    const sttLang = selectedLanguages[0]?.speechCode ?? 'ja-JP'
    const recognition = new Ctor()
    recognition.lang = sttLang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => setIsRecording(true)

    recognition.onresult = (event: any) => {
      let final = '', interim = ''
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) final += event.results[i][0].transcript
        else interim += event.results[i][0].transcript
      }
      const sessionText = final + interim
      recognizedTextRef.current = accumulatedRef.current
        ? accumulatedRef.current + ' ' + sessionText
        : sessionText
    }

    recognition.onerror = () => {
      userStoppedRef.current = true
      setIsRecording(false)
    }

    recognition.onend = () => {
      if (userStoppedRef.current) {
        setIsRecording(false)
        const text = recognizedTextRef.current.trim()
        if (text) onStart(text)
        return
      }
      // Safari の自動停止対策：auto-restart
      accumulatedRef.current = recognizedTextRef.current
      try { recognition.start() } catch { setIsRecording(false) }
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  const stopSTT = () => {
    userStoppedRef.current = true
    recognitionRef.current?.stop()
  }

  const handleMicPress = () => {
    if (!canStart) return
    if (!isRecording) startSTT()
    else stopSTT()
  }

  return (
    <main className="language-select-page">
      <header className="page-header">
        <h1 className="app-title">GoTalk</h1>
      </header>

      <section className="language-grid" aria-label="使用する言語を2つ選択">
        {LANGUAGES.map(lang => {
          const selected = selectedLanguages.some(l => l.id === lang.id)
          return (
            <button
              key={lang.id}
              type="button"
              className={`flagCard ${selected ? 'selected' : 'unselected'}`}
              onClick={() => handleCardTap(lang)}
              aria-pressed={selected}
              aria-label={lang.label}
            >
              <img className="flagIcon" src={`/flags/${lang.id}.svg`} alt="" aria-hidden="true" />
            </button>
          )
        })}
      </section>

      <footer className="page-footer">
        <button
          type="button"
          className={[
            'mic-start-button',
            isRecording ? 'mic-start-button--recording' : (canStart ? 'mic-start-button--active' : ''),
          ].join(' ')}
          onClick={handleMicPress}
          disabled={!canStart && !isRecording}
          aria-label={isRecording ? '録音を停止する' : '会話を開始する'}
          aria-pressed={isRecording}
        >
          {isRecording ? <StopIcon /> : <MicIcon />}
        </button>
      </footer>
    </main>
  )
}

function StopIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
