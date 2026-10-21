// 5回目の実験の recogonly（docs/testing.md の「実験のスイッチ」）で、音声認識の始め直しの前と後の文字をつなぐ。
// LegacyInterpreterPage.tsx から export すると、部品でないものの export になるので、別のファイルにしている。
// 原因が分かったら、このファイルは外す

// 区切りを足さない言語（ほかの言語は半角の空白を1つ足す）
const NO_SEPARATOR_LANGS: readonly string[] = ['ja', 'zh-CN', 'zh-TW']

// left と right をつなぐ。どちらかが空（前後の空白を除いて）なら、もう一方をそのまま返す。
// en、ko、th、vi は、left の末尾か right の先頭がすでに空白でなければ、半角の空白を1つ足す。文字の中身は変えない
export function joinRecognitionSegments(langId: string, left: string, right: string): string {
  if (left.trim() === '') return right
  if (right.trim() === '') return left
  if (NO_SEPARATOR_LANGS.includes(langId)) return left + right
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right
  return `${left} ${right}`
}
