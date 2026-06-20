import { useState } from 'react'
import type { Language } from './languages'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'
import TtsTestPage from './pages/TtsTestPage'

type Page = 'language-select' | 'interpreter'

export default function App() {
  if (window.location.hash === '#tts-test') return <TtsTestPage />

  const [page, setPage] = useState<Page>('language-select')
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([])
  const [pendingAudio, setPendingAudio] = useState<Blob | null>(null)

  const handleStart = (audioBlob: Blob) => {
    setPendingAudio(audioBlob)
    setPage('interpreter')
  }

  const handleBack = () => {
    setPendingAudio(null)
    setPage('language-select')
  }

  if (page === 'interpreter') {
    return (
      <InterpreterPage
        selectedLanguages={selectedLanguages}
        onBack={handleBack}
        pendingAudio={pendingAudio ?? undefined}
      />
    )
  }

  return (
    <LanguageSelectPage
      selectedLanguages={selectedLanguages}
      onSelectionChange={setSelectedLanguages}
      onStart={handleStart}
    />
  )
}
