// 2回目から録音が空になる不具合の切り分けの実験のスイッチ（docs/testing.md の「実験のスイッチ」）。
// URL の query の exp で指定する（例：?exp=norecog、?exp=nometer,norecog）。hash は使わない（#mic-test などと衝突させないため）。
// 画面を読み込んだときに一度だけ読み取り、変わらない値として通訳の画面と useAudioSession に渡す。
// 原因が分かったら、本番の修正を別の PR で入れ、このファイルとスイッチ、診断の表示、legacy の部品は外す

export const EXPERIMENT_NAMES = [
  'legacy',
  'legacykeep',
  'legacymute',
  'norecog',
  'legacyrecog',
  'nometer',
  'nodisconnect',
  'awaitclose',
  'notrackread',
  'noendedlistener',
  'nolifecycle',
  'trace',
  'recogfirst',
  'recogabort',
  'recogdelay',
  'recogearly',
  'recogonce',
] as const

export type ExperimentName = typeof EXPERIMENT_NAMES[number]

export interface InactiveExperiment {
  name: ExperimentName
  reason: string
}

export interface ExperimentConfig {
  // URL に exp があるか（?exp= の空の指定でも true）
  enabled: boolean
  // exp の元の文字列（ないときは null）
  raw: string | null
  // 受け付けた名前（知っている名前。重複は除く）
  requested: ExperimentName[]
  // 知らない名前（タイプミスなど）
  ignored: string[]
  // 知っているが、組み合わせで意味がなくなった名前と、その理由
  inactive: InactiveExperiment[]
  // 実際に効いている名前
  effective: ExperimentName[]
  legacy: boolean
  // 3回目の実験（legacy に、マイクの使い回しだけを加えたもの）
  legacyKeep: boolean
  // 4回目の実験（legacykeep に、録音の後の track の無効と、次の録音の開始での有効を加えたもの）。
  // true のときは legacyKeep も true にする（legacykeep のすべての動きを使うため）
  legacyMute: boolean
  noRecog: boolean
  legacyRecog: boolean
  noMeter: boolean
  noDisconnect: boolean
  awaitClose: boolean
  noTrackRead: boolean
  noEndedListener: boolean
  noLifecycle: boolean
  trace: boolean
  // 2回目の実験（音声認識を残したまま、録音を壊さない終わり方と始め方）
  recogFirst: boolean
  recogAbort: boolean
  recogDelay: boolean
  recogEarly: boolean
  recogOnce: boolean
}

// exp がないときの値。すべてのスイッチが false で、今の本番と同じ動き
export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = Object.freeze({
  enabled: false,
  raw: null,
  requested: [],
  ignored: [],
  inactive: [],
  effective: [],
  legacy: false,
  legacyKeep: false,
  legacyMute: false,
  noRecog: false,
  legacyRecog: false,
  noMeter: false,
  noDisconnect: false,
  awaitClose: false,
  noTrackRead: false,
  noEndedListener: false,
  noLifecycle: false,
  trace: false,
  recogFirst: false,
  recogAbort: false,
  recogDelay: false,
  recogEarly: false,
  recogOnce: false,
}) as ExperimentConfig

export interface ParsedExperimentQuery {
  enabled: boolean
  raw: string | null
  // コンマで区切り、前後の空白を除き、空のものを除いた名前（大文字と小文字はそのまま）
  names: string[]
}

// URL の query（location.search）から exp を読む。exp があるかは URLSearchParams.has で判定する
export function parseExperimentQuery(search: string): ParsedExperimentQuery {
  const params = new URLSearchParams(search)
  if (!params.has('exp')) return { enabled: false, raw: null, names: [] }
  // has('exp') の後なので、get は文字列を返す（?exp だけのときは空の文字列）
  const raw = params.get('exp') as string
  const names = raw.split(',').map(n => n.trim()).filter(n => n !== '')
  return { enabled: true, raw, names }
}

// 音声認識を使うスイッチ（norecog と組み合わせると意味がなくなる）
const RECOGNITION_SWITCHES: readonly ExperimentName[] = ['legacyrecog', 'recogfirst', 'recogabort', 'recogdelay', 'recogearly', 'recogonce']
// 今の版の音声認識の扱いを変える2回目の実験のスイッチ（legacyrecog より優先）
const RECOGNITION_VARIANTS: readonly ExperimentName[] = ['recogfirst', 'recogabort', 'recogearly', 'recogonce']

const isExperimentName = (name: string): name is ExperimentName => (EXPERIMENT_NAMES as readonly string[]).includes(name)

// 名前の一覧から、組み合わせを解いた ExperimentConfig を作る
// - legacy は単独。ほかの名前（trace も）は inactive
// - legacymute も単独。ほかの名前（legacy と legacykeep も）は inactive。legacy と legacykeep より優先
//   （legacymute は legacykeep に track の無効と有効を加えたもの）。legacyMute と legacyKeep の両方を true にする
// - legacykeep も単独。ほかの名前（legacy と trace も）は inactive。legacy と一緒のときは legacykeep を使う
//   （legacykeep は legacy にマイクの使い回しを加えたもの）
// - nometer は nodisconnect と awaitclose より優先
// - nodisconnect と awaitclose は組み合わせて使える
// - norecog は、音声認識を使うスイッチ（legacyrecog、recogfirst、recogabort、recogdelay、recogearly、recogonce）より優先
// - recogdelay は recogfirst と一緒のときだけ効く
// - recogfirst、recogabort、recogearly、recogonce は、legacyrecog より優先（今の版の音声認識の扱いを変えて調べるため）
// - recogfirst と recogabort、recogfirst と awaitclose は組み合わせて使える
export function resolveExperimentConfig(parsed: ParsedExperimentQuery): ExperimentConfig {
  if (!parsed.enabled) return DEFAULT_EXPERIMENT_CONFIG
  const requested: ExperimentName[] = []
  const ignored: string[] = []
  for (const name of parsed.names) {
    if (isExperimentName(name)) {
      if (!requested.includes(name)) requested.push(name)
    } else if (!ignored.includes(name)) {
      ignored.push(name)
    }
  }

  const inactive: InactiveExperiment[] = []
  const has = (name: ExperimentName) => requested.includes(name)
  let effective: ExperimentName[]
  if (has('legacymute')) {
    effective = ['legacymute']
    for (const name of requested) {
      if (name === 'legacy' || name === 'legacykeep') inactive.push({ name, reason: 'legacymute が優先（legacymute は legacykeep に track の無効と有効を加えたもの）' })
      else if (name !== 'legacymute') inactive.push({ name, reason: 'legacymute と組み合わせない' })
    }
  } else if (has('legacykeep')) {
    effective = ['legacykeep']
    for (const name of requested) {
      if (name === 'legacy') inactive.push({ name, reason: 'legacykeep が優先（legacykeep は legacy にマイクの使い回しを加えたもの）' })
      else if (name !== 'legacykeep') inactive.push({ name, reason: 'legacykeep と組み合わせない' })
    }
  } else if (has('legacy')) {
    effective = ['legacy']
    for (const name of requested) {
      if (name !== 'legacy') inactive.push({ name, reason: 'legacy と組み合わせない' })
    }
  } else {
    const off = new Map<ExperimentName, string>()
    if (has('norecog')) {
      for (const name of RECOGNITION_SWITCHES) {
        if (has(name)) off.set(name, 'norecog が優先')
      }
    } else {
      if (has('recogdelay') && !has('recogfirst')) off.set('recogdelay', 'recogfirst と一緒のときだけ効く')
      const overLegacyRecog = RECOGNITION_VARIANTS.filter(has)
      if (has('legacyrecog') && overLegacyRecog.length > 0) off.set('legacyrecog', `${overLegacyRecog.join('、')} が優先`)
    }
    if (has('nometer')) {
      if (has('nodisconnect')) off.set('nodisconnect', 'nometer が優先')
      if (has('awaitclose')) off.set('awaitclose', 'nometer が優先')
    }
    effective = requested.filter(name => !off.has(name))
    for (const name of requested) {
      const reason = off.get(name)
      if (reason) inactive.push({ name, reason })
    }
  }

  const on = (name: ExperimentName) => effective.includes(name)
  return {
    enabled: true,
    raw: parsed.raw,
    requested,
    ignored,
    inactive,
    effective,
    legacy: on('legacy'),
    // legacymute は legacykeep のすべての動きを使う
    legacyKeep: on('legacykeep') || on('legacymute'),
    legacyMute: on('legacymute'),
    noRecog: on('norecog'),
    legacyRecog: on('legacyrecog'),
    noMeter: on('nometer'),
    noDisconnect: on('nodisconnect'),
    awaitClose: on('awaitclose'),
    noTrackRead: on('notrackread'),
    noEndedListener: on('noendedlistener'),
    noLifecycle: on('nolifecycle'),
    trace: on('trace'),
    recogFirst: on('recogfirst'),
    recogAbort: on('recogabort'),
    recogDelay: on('recogdelay'),
    recogEarly: on('recogearly'),
    recogOnce: on('recogonce'),
  }
}

export function readExperimentConfig(search: string): ExperimentConfig {
  return resolveExperimentConfig(parseExperimentQuery(search))
}
