import { describe, it, expect } from 'vitest'
import { joinRecognitionSegments } from './recogOnlyText'

// 5回目の実験の recogonly で、音声認識の始め直しの前と後の文字をつなぐ関数（docs/testing.md の「実験のスイッチ」）
describe('joinRecognitionSegments', () => {
  it('joins without a separator for ja, zh-CN and zh-TW', () => {
    expect(joinRecognitionSegments('ja', 'わたしのなまえは', 'ありたしんです')).toBe('わたしのなまえはありたしんです')
    expect(joinRecognitionSegments('zh-CN', '我的名字', '是有田')).toBe('我的名字是有田')
    expect(joinRecognitionSegments('zh-TW', '我的名字', '是有田')).toBe('我的名字是有田')
  })

  it('adds one space for en, ko, th and vi', () => {
    expect(joinRecognitionSegments('en', 'My name is', 'Shin')).toBe('My name is Shin')
    expect(joinRecognitionSegments('ko', '제 이름은', '신입니다')).toBe('제 이름은 신입니다')
    expect(joinRecognitionSegments('th', 'ฉันชื่อ', 'ชิน')).toBe('ฉันชื่อ ชิน')
    expect(joinRecognitionSegments('vi', 'Tên tôi là', 'Shin')).toBe('Tên tôi là Shin')
  })

  it('does not add a space when there is already one', () => {
    expect(joinRecognitionSegments('en', 'My name is ', 'Shin')).toBe('My name is Shin')
    expect(joinRecognitionSegments('en', 'My name is', ' Shin')).toBe('My name is Shin')
    expect(joinRecognitionSegments('ko', '제 이름은\n', '신입니다')).toBe('제 이름은\n신입니다')
  })

  it('returns the other side as is when one side is empty or blank', () => {
    expect(joinRecognitionSegments('en', '', 'Shin')).toBe('Shin')
    expect(joinRecognitionSegments('en', 'Shin', '')).toBe('Shin')
    expect(joinRecognitionSegments('en', '  ', ' Shin ')).toBe(' Shin ')
    expect(joinRecognitionSegments('ja', 'わたし ', '   ')).toBe('わたし ')
    expect(joinRecognitionSegments('ja', '', '')).toBe('')
  })

  it('does not change the text inside', () => {
    expect(joinRecognitionSegments('ja', 'わたし の', ' なまえ')).toBe('わたし の なまえ')
    expect(joinRecognitionSegments('en', 'a  b', 'c  d')).toBe('a  b c  d')
  })
})
