import { useState, useEffect } from 'react'

export default function TtsTestPage() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [log, setLog] = useState<string[]>([])

  const addLog = (msg: string) =>
    setLog(prev => [`${new Date().toISOString().slice(11, 23)} ${msg}`, ...prev])

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  const speak = (text: string, lang: string) => {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.onstart = () => addLog(`onstart lang=${lang}`)
    u.onend = () => addLog(`onend lang=${lang}`)
    u.onerror = (e: SpeechSynthesisErrorEvent) => addLog(`onerror lang=${lang} error=${e.error}`)
    window.speechSynthesis.speak(u)
  }

  return (
    <main style={{ padding: '24px', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '24px' }}>TTS Test</h1>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
        <button
          onClick={() => speak('こんにちは', 'ja-JP')}
          style={{ padding: '12px 20px', fontSize: '16px' }}
        >
          こんにちはを喋る
        </button>
        <button
          onClick={() => speak('สวัสดีครับ', 'th-TH')}
          style={{ padding: '12px 20px', fontSize: '16px' }}
        >
          タイ語を喋る
        </button>
      </div>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '8px' }}>
          getVoices() — {voices.length} 件
        </h2>
        <div style={{ height: '200px', overflowY: 'auto', border: '1px solid #ccc', padding: '8px', fontSize: '13px', fontFamily: 'monospace' }}>
          {voices.length === 0 ? (
            <p style={{ color: '#999' }}>（なし）</p>
          ) : (
            voices.map((v, i) => (
              <div key={i}>{v.name} / {v.lang}</div>
            ))
          )}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: '16px', marginBottom: '8px' }}>イベントログ</h2>
        <div style={{ height: '200px', overflowY: 'auto', border: '1px solid #ccc', padding: '8px', fontSize: '13px', fontFamily: 'monospace' }}>
          {log.length === 0 ? (
            <p style={{ color: '#999' }}>（なし）</p>
          ) : (
            log.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </section>
    </main>
  )
}
