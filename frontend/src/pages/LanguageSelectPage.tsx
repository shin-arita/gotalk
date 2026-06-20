import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import { LANGUAGES } from '../languages'
import './LanguageSelectPage.css'

interface Props {
  selectedLanguages: Language[]
  onSelectionChange: (langs: Language[]) => void
  onStart: (audioBlob: Blob) => void
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

export default function LanguageSelectPage({ selectedLanguages, onSelectionChange, onStart }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const userStoppedRef = useRef(false)

  const canStart = selectedLanguages.length === 2

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
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

  const startRecording = async () => {
    const mimeType = getSupportedMimeType()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      audioChunksRef.current = []
      userStoppedRef.current = false

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        if (!userStoppedRef.current) return
        const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' })
        onStart(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setIsRecording(true)
    } catch {
      setIsRecording(false)
    }
  }

  const stopRecording = () => {
    userStoppedRef.current = true
    mediaRecorderRef.current?.stop()
    setIsRecording(false)
  }

  const handleMicPress = () => {
    if (!canStart) return
    if (!isRecording) startRecording()
    else stopRecording()
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
