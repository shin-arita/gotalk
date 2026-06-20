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
  const [pendingText, setPendingText] = useState('')

  const handleStart = (text: string) => {
    setPendingText(text)
    setPage('interpreter')
  }

  const handleBack = () => {
    setPendingText('')
    setPage('language-select')
  }

  if (page === 'interpreter') {
    return (
      <InterpreterPage
        selectedLanguages={selectedLanguages}
        onBack={handleBack}
        pendingText={pendingText}
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
