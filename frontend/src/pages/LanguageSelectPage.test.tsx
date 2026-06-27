import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import LanguageSelectPage from './LanguageSelectPage'
import { LANGUAGES } from '../languages'
import type { Language } from '../languages'

const [ja, en, zhCN] = LANGUAGES

function renderPage(
  selectedLanguages: Language[] = [],
  onSelectionChange = vi.fn(),
  onNavigate = vi.fn(),
) {
  return render(
    <LanguageSelectPage
      selectedLanguages={selectedLanguages}
      onSelectionChange={onSelectionChange}
      onNavigate={onNavigate}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ============================================================
// Rendering
// ============================================================

describe('LanguageSelectPage rendering', () => {
  it('renders all 7 language cards', () => {
    renderPage()
    const buttons = screen.getAllByRole('button', { name: /Japanese|English|Chinese|Korean|Thai|Tiếng Việt/ })
    expect(buttons).toHaveLength(7)
  })

  it('renders the app title', () => {
    renderPage()
    expect(screen.getByText('GoTalk')).toBeInTheDocument()
  })

  it('selected card has aria-pressed=true', () => {
    renderPage([ja])
    expect(screen.getByRole('button', { name: 'Japanese' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('unselected card has aria-pressed=false', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Japanese' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders no footer mic button', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: '会話を開始する' })).not.toBeInTheDocument()
  })
})

// ============================================================
// Card selection
// ============================================================

describe('LanguageSelectPage card selection', () => {
  it('calls onSelectionChange with the tapped language when unselected', () => {
    const onSelectionChange = vi.fn()
    renderPage([], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onSelectionChange).toHaveBeenCalledWith([ja])
  })

  it('calls onSelectionChange without the language when already selected', () => {
    const onSelectionChange = vi.fn()
    renderPage([ja], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('does not add a third language when 2 are already selected', () => {
    const onSelectionChange = vi.fn()
    renderPage([ja, en], onSelectionChange)
    fireEvent.click(screen.getByRole('button', { name: 'Chinese Simplified' }))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

// ============================================================
// Auto-navigation
// ============================================================

describe('LanguageSelectPage auto-navigation', () => {
  it('calls onNavigate when the second language is selected', () => {
    const onNavigate = vi.fn()
    renderPage([ja], vi.fn(), onNavigate)
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('does not call onNavigate when only the first language is selected', () => {
    const onNavigate = vi.fn()
    renderPage([], vi.fn(), onNavigate)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not call onNavigate when a selected language is deselected', () => {
    const onNavigate = vi.fn()
    renderPage([ja, en], vi.fn(), onNavigate)
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('calls onSelectionChange before onNavigate', () => {
    const calls: string[] = []
    const onSelectionChange = vi.fn(() => calls.push('selection'))
    const onNavigate = vi.fn(() => calls.push('navigate'))
    renderPage([ja], onSelectionChange, onNavigate)
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(calls).toEqual(['selection', 'navigate'])
  })
})

// ============================================================
// Unmount
// ============================================================

describe('LanguageSelectPage unmount', () => {
  it('unmounts without throwing', () => {
    renderPage([ja, en])
    expect(() => cleanup()).not.toThrow()
  })
})
