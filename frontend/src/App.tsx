import { useState } from 'react'
import type { Language } from './languages'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'
import TtsTestPage from './pages/TtsTestPage'

type Page = 'language-select' | 'interpreter'

export default function App() {
  const [page, setPage] = useState<Page>('language-select')
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([])

  if (window.location.hash === '#tts-test') return <TtsTestPage />

  const handleNavigate = () => {
    setPage('interpreter')
  }

  const handleBack = () => {
    setPage('language-select')
  }

  if (page === 'interpreter') {
    return (
      <InterpreterPage
        selectedLanguages={selectedLanguages}
        onBack={handleBack}
      />
    )
  }

  return (
    <LanguageSelectPage
      selectedLanguages={selectedLanguages}
      onSelectionChange={setSelectedLanguages}
      onNavigate={handleNavigate}
    />
  )
}
