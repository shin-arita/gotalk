import { useState } from 'react'
import type { Language } from './languages'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'
import TtsTestPage from './pages/TtsTestPage'

type Page = 'language-select' | 'interpreter'

export default function App() {
  const [page, setPage] = useState<Page>('language-select')
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([])
  // 診断の表示（docs/testing.md の「診断の表示（?diag）」）。URL の query に diag があれば出す（値は見ない）。
  // 画面を読み込んだときに一度だけ読み、途中で URL を変えても反映しない
  const [showDiagnostics] = useState(() => new URLSearchParams(window.location.search).has('diag'))

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
        showDiagnostics={showDiagnostics}
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
