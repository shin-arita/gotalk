import { useState } from 'react'
import './LanguageSelectPage.css'

interface LanguageSelectPageProps {
  onStart: (myLanguage: string, theirLanguage: string) => void
}

export default function LanguageSelectPage({ onStart }: LanguageSelectPageProps) {
  const [myLanguage, setMyLanguage] = useState('日本語')
  const [theirLanguage, setTheirLanguage] = useState('ไทย')

  const handleSwap = () => {
    setMyLanguage(theirLanguage)
    setTheirLanguage(myLanguage)
  }

  return (
    <main className="language-select-page">
      <header className="page-header">
        <h1 className="app-title">GoTalk</h1>
        <p className="app-subtitle">言葉が通じなくても、その場で会話できる</p>
      </header>

      <section className="language-section">
        <div className="language-group">
          <span className="language-label">あなたの言語</span>
          <button type="button" className="language-card">
            {myLanguage}
          </button>
        </div>

        <div className="swap-row">
          <button
            type="button"
            className="swap-button"
            onClick={handleSwap}
            aria-label="言語を入れ替える"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 7l3-3m0 0l3 3M7 4v12M16 13l-3 3m0 0l-3-3m3 3V4"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            入れ替え
          </button>
        </div>

        <div className="language-group">
          <span className="language-label">相手の言語</span>
          <button type="button" className="language-card">
            {theirLanguage}
          </button>
        </div>
      </section>

      <footer className="page-footer">
        <button
          type="button"
          className="start-button"
          onClick={() => onStart(myLanguage, theirLanguage)}
        >
          会話を開始する
        </button>
      </footer>
    </main>
  )
}
