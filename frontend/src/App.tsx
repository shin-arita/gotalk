import { useState } from 'react'
import type { Language } from './languages'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'
import LegacyInterpreterPage from './pages/LegacyInterpreterPage'
import { readExperimentConfig } from './experiments'
import TtsTestPage from './pages/TtsTestPage'
import MicTestPage from './pages/MicTestPage'

type Page = 'language-select' | 'interpreter'

export default function App() {
  const [page, setPage] = useState<Page>('language-select')
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([])
  // 切り分けの実験のスイッチ（docs/testing.md）。画面を読み込んだときに一度だけ読み、途中で URL を変えても反映しない
  const [experiment] = useState(() => readExperimentConfig(window.location.search))

  if (window.location.hash === '#tts-test') return <TtsTestPage />
  if (window.location.hash === '#mic-test') return <MicTestPage />

  const handleNavigate = () => {
    setPage('interpreter')
  }

  const handleBack = () => {
    setPage('language-select')
  }

  if (page === 'interpreter') {
    // 実験の legacy と legacykeep：PR #26 の前の通訳の画面を、別の部品として使う（recogonly も同じ部品を使う）
    if (experiment.legacy || experiment.legacyKeep || experiment.recogOnly) {
      return (
        <LegacyInterpreterPage
          selectedLanguages={selectedLanguages}
          onBack={handleBack}
          experiment={experiment}
        />
      )
    }
    return (
      <InterpreterPage
        selectedLanguages={selectedLanguages}
        onBack={handleBack}
        experiment={experiment}
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
