import { useState } from 'react'
import LanguageSelectPage from './pages/LanguageSelectPage'
import InterpreterPage from './pages/InterpreterPage'

type Page = 'language-select' | 'interpreter'

interface AppState {
  page: Page
  myLanguage: string
  theirLanguage: string
}

export default function App() {
  const [state, setState] = useState<AppState>({
    page: 'language-select',
    myLanguage: '日本語',
    theirLanguage: 'ไทย',
  })

  if (state.page === 'interpreter') {
    return (
      <InterpreterPage
        myLanguage={state.myLanguage}
        theirLanguage={state.theirLanguage}
        onBack={() => setState(s => ({ ...s, page: 'language-select' }))}
      />
    )
  }

  return (
    <LanguageSelectPage
      onStart={(myLanguage, theirLanguage) =>
        setState({ page: 'interpreter', myLanguage, theirLanguage })
      }
    />
  )
}
