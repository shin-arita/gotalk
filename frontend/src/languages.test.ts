import { describe, it, expect } from 'vitest'
import { LANGUAGES } from './languages'
import type { Language } from './languages'

describe('LANGUAGES', () => {
  it('has exactly 7 entries', () => {
    expect(LANGUAGES).toHaveLength(7)
  })

  it('each entry has required fields', () => {
    for (const lang of LANGUAGES) {
      expect(lang.id).toBeTruthy()
      expect(lang.speechCode).toBeTruthy()
      expect(lang.label).toBeTruthy()
    }
  })

  it('all ids are unique', () => {
    const ids = LANGUAGES.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('contains Japanese with correct speechCode', () => {
    const ja = LANGUAGES.find(l => l.id === 'ja')
    expect(ja).toEqual<Language>({ id: 'ja', speechCode: 'ja-JP', label: 'Japanese' })
  })

  it('contains English with correct speechCode', () => {
    const en = LANGUAGES.find(l => l.id === 'en')
    expect(en).toEqual<Language>({ id: 'en', speechCode: 'en-US', label: 'English' })
  })

  it('contains Chinese Simplified', () => {
    const zh = LANGUAGES.find(l => l.id === 'zh-CN')
    expect(zh).toEqual<Language>({ id: 'zh-CN', speechCode: 'zh-CN', label: 'Chinese Simplified' })
  })

  it('contains Chinese Traditional', () => {
    const zh = LANGUAGES.find(l => l.id === 'zh-TW')
    expect(zh).toEqual<Language>({ id: 'zh-TW', speechCode: 'zh-TW', label: 'Chinese Traditional' })
  })

  it('contains Korean with correct speechCode', () => {
    const ko = LANGUAGES.find(l => l.id === 'ko')
    expect(ko).toEqual<Language>({ id: 'ko', speechCode: 'ko-KR', label: 'Korean' })
  })

  it('contains Thai with correct speechCode', () => {
    const th = LANGUAGES.find(l => l.id === 'th')
    expect(th).toEqual<Language>({ id: 'th', speechCode: 'th-TH', label: 'Thai' })
  })

  it('contains Vietnamese with correct speechCode', () => {
    const vi = LANGUAGES.find(l => l.id === 'vi')
    expect(vi).toEqual<Language>({ id: 'vi', speechCode: 'vi-VN', label: 'Tiếng Việt' })
  })
})
