import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// 画面の経路と、診断の表示（?diag）を読むこと（docs/testing.md の「診断の表示（?diag）」）。
// ?exp= は外した後は何もしない。#mic-test のページはなく、ふつうの画面になる

const rendered = vi.hoisted(() => ({ current: [] as { name: string; showDiagnostics?: boolean }[] }))

vi.mock('./pages/LanguageSelectPage', () => ({
  default: ({ onNavigate }: { onNavigate: () => void }) => <button type="button" onClick={onNavigate}>next</button>,
}))
vi.mock('./pages/InterpreterPage', () => ({
  default: ({ showDiagnostics, onBack }: { showDiagnostics?: boolean; onBack: () => void }) => {
    rendered.current.push({ name: 'InterpreterPage', showDiagnostics })
    return <button type="button" onClick={onBack}>back</button>
  },
}))
vi.mock('./pages/TtsTestPage', () => ({
  default: () => <p>tts-test</p>,
}))

const { default: App } = await import('./App')

afterEach(() => {
  cleanup()
  rendered.current = []
  window.history.replaceState(null, '', '/')
})

function openInterpreter(url: string) {
  window.history.replaceState(null, '', url)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
}

const lastShowDiagnostics = () => rendered.current.at(-1)?.showDiagnostics

describe('App routing and ?diag', () => {
  it.each([
    ['/', false],
    ['/?diag', true],
    ['/?diag=', true],
    ['/?diag=0', true],
    ['/?diag=1', true],
    ['/?DIAG', false],
    ['/#diag', false],
    ['/?exp=', false],
    ['/?exp=legacy', false],
    ['/?exp=legacykeep', false],
    ['/?exp=legacymute', false],
    ['/?exp=recogonly', false],
    ['/?exp=trace', false],
    ['/?exp=trace&diag', true],
  ])('opens the interpreter page for %s with showDiagnostics=%s', (url, expected) => {
    openInterpreter(url)
    expect(screen.getByRole('button', { name: 'back' })).toBeInTheDocument()
    expect(rendered.current.length).toBeGreaterThan(0)
    expect(rendered.current.every(r => r.name === 'InterpreterPage' && r.showDiagnostics === expected)).toBe(true)
  })

  it('keeps the TtsTestPage for #tts-test, also with ?diag', () => {
    window.history.replaceState(null, '', '/?diag#tts-test')
    render(<App />)
    expect(screen.getByText('tts-test')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'next' })).toBeNull()
    expect(rendered.current).toEqual([])
  })

  it('shows the language selection for #mic-test (there is no microphone test page)', () => {
    window.history.replaceState(null, '', '/#mic-test')
    render(<App />)
    expect(screen.getByRole('button', { name: 'next' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'next' }))
    expect(lastShowDiagnostics()).toBe(false)
  })

  it.each([
    ['/?diag', '/', true],
    ['/', '/?diag', false],
  ])('reads diag only once when the screen loads (%s, then %s), also after going back and opening again', (first, later, expected) => {
    window.history.replaceState(null, '', first)
    render(<App />)
    window.history.replaceState(null, '', later)
    fireEvent.click(screen.getByRole('button', { name: 'next' }))
    expect(lastShowDiagnostics()).toBe(expected)
    // 言語の選択に戻り、もう一度開いても、最初に読んだ値のまま
    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    expect(screen.getByRole('button', { name: 'next' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'next' }))
    expect(lastShowDiagnostics()).toBe(expected)
  })
})
