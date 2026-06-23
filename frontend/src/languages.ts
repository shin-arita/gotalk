export interface Language {
  id: string
  speechCode: string
  label: string
}

export const LANGUAGES: Language[] = [
  { id: 'ja',    speechCode: 'ja-JP', label: 'Japanese' },
  { id: 'en',    speechCode: 'en-US', label: 'English' },
  { id: 'zh-CN', speechCode: 'zh-CN', label: 'Chinese Simplified' },
  { id: 'zh-TW', speechCode: 'zh-TW', label: 'Chinese Traditional' },
  { id: 'ko',    speechCode: 'ko-KR', label: 'Korean' },
  { id: 'th',    speechCode: 'th-TH', label: 'Thai' },
  { id: 'vi',    speechCode: 'vi-VN', label: 'Tiếng Việt' },
]
