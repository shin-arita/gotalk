import { useState } from 'react'
import type { Language } from './languages'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'
import TtsTestPage from './pages/TtsTestPage'
import MicTestPage from './pages/MicTestPage'

type Page = 'language-select' | 'interpreter'

export default function App() {
  const [page, setPage] = useState<Page>('language-select')
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([])

  if (window.location.hash === '#tts-test') return <TtsTestPage />
  if (window.location.hash === '#mic-test') return <MicTestPage />

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
