import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ExperimentConfig } from './experiments'

// 切り分けの実験の legacy で、通訳の画面の代わりに LegacyInterpreterPage を使うこと（docs/testing.md の「実験のスイッチ」）

const rendered = vi.hoisted(() => ({ current: [] as { name: string; experiment?: ExperimentConfig }[] }))

vi.mock('./pages/LanguageSelectPage', () => ({
  default: ({ onNavigate }: { onNavigate: () => void }) => <button type="button" onClick={onNavigate}>next</button>,
}))
vi.mock('./pages/InterpreterPage', () => ({
  default: ({ experiment }: { experiment?: ExperimentConfig }) => { rendered.current.push({ name: 'InterpreterPage', experiment }); return <p>current</p> },
}))
vi.mock('./pages/LegacyInterpreterPage', () => ({
  default: ({ experiment }: { experiment?: ExperimentConfig }) => { rendered.current.push({ name: 'LegacyInterpreterPage', experiment }); return <p>legacy</p> },
}))

const { default: App } = await import('./App')

afterEach(() => {
  cleanup()
  rendered.current = []
  window.history.replaceState(null, '', '/')
})

function openInterpreter(search: string) {
  window.history.replaceState(null, '', `/${search}`)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
}

describe('App experiment routing', () => {
  it('uses the current InterpreterPage without exp', () => {
    openInterpreter('')
    expect(screen.getByText('current')).toBeInTheDocument()
    expect(rendered.current.every(r => r.name === 'InterpreterPage')).toBe(true)
    expect(rendered.current[0].experiment?.enabled).toBe(false)
  })

  it('uses LegacyInterpreterPage with exp=legacy', () => {
    openInterpreter('?exp=legacy')
    expect(screen.getByText('legacy')).toBeInTheDocument()
    expect(rendered.current.every(r => r.name === 'LegacyInterpreterPage')).toBe(true)
    expect(rendered.current[0].experiment?.effective).toEqual(['legacy'])
  })

  it('uses LegacyInterpreterPage with exp=legacykeep', () => {
    openInterpreter('?exp=legacykeep')
    expect(screen.getByText('legacy')).toBeInTheDocument()
    expect(rendered.current.every(r => r.name === 'LegacyInterpreterPage')).toBe(true)
    expect(rendered.current[0].experiment?.effective).toEqual(['legacykeep'])
    expect(rendered.current[0].experiment?.legacyKeep).toBe(true)
    expect(rendered.current[0].experiment?.legacy).toBe(false)
  })

  it('uses LegacyInterpreterPage with exp=legacy,legacykeep', () => {
    openInterpreter('?exp=legacy,legacykeep')
    expect(rendered.current.every(r => r.name === 'LegacyInterpreterPage')).toBe(true)
    expect(rendered.current[0].experiment?.effective).toEqual(['legacykeep'])
  })

  it('uses the current InterpreterPage with the other switches', () => {
    openInterpreter('?exp=norecog')
    expect(screen.getByText('current')).toBeInTheDocument()
    expect(rendered.current[0].experiment?.noRecog).toBe(true)
  })

  it('reads exp only once when the screen loads', () => {
    window.history.replaceState(null, '', '/?exp=legacy')
    render(<App />)
    window.history.replaceState(null, '', '/')
    fireEvent.click(screen.getByRole('button', { name: 'next' }))
    expect(screen.getByText('legacy')).toBeInTheDocument()
  })
})
