import type { Language } from '../languages'
import { LANGUAGES } from '../languages'
import './LanguageSelectPage.css'

interface Props {
  selectedLanguages: Language[]
  onSelectionChange: (langs: Language[]) => void
  onNavigate: () => void
}

export default function LanguageSelectPage({ selectedLanguages, onSelectionChange, onNavigate }: Props) {
  const handleCardTap = (lang: Language) => {
    const isSelected = selectedLanguages.some(l => l.id === lang.id)
    let newSelection: Language[]
    if (isSelected) {
      newSelection = selectedLanguages.filter(l => l.id !== lang.id)
    } else if (selectedLanguages.length < 2) {
      newSelection = [...selectedLanguages, lang]
    } else {
      return
    }
    onSelectionChange(newSelection)
    if (newSelection.length === 2) {
      onNavigate()
    }
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
    </main>
  )
}
