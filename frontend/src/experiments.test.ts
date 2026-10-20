import { describe, it, expect } from 'vitest'
import { DEFAULT_EXPERIMENT_CONFIG, parseExperimentQuery, readExperimentConfig, resolveExperimentConfig } from './experiments'

describe('parseExperimentQuery', () => {
  it('is not enabled when there is no exp', () => {
    expect(parseExperimentQuery('')).toEqual({ enabled: false, raw: null, names: [] })
    expect(parseExperimentQuery('?foo=1')).toEqual({ enabled: false, raw: null, names: [] })
  })

  it('is enabled with an empty exp', () => {
    expect(parseExperimentQuery('?exp=')).toEqual({ enabled: true, raw: '', names: [] })
    expect(parseExperimentQuery('?exp')).toEqual({ enabled: true, raw: '', names: [] })
  })

  it('splits by comma and trims the names', () => {
    expect(parseExperimentQuery('?exp=nometer,%20norecog,,')).toEqual({ enabled: true, raw: 'nometer, norecog,,', names: ['nometer', 'norecog'] })
  })
})

describe('resolveExperimentConfig', () => {
  it('returns the default config without exp', () => {
    const config = readExperimentConfig('')
    expect(config).toBe(DEFAULT_EXPERIMENT_CONFIG)
    expect(config.enabled).toBe(false)
    expect(config.effective).toEqual([])
  })

  it('is enabled with no switches for an empty exp', () => {
    const config = readExperimentConfig('?exp=')
    expect(config).toMatchObject({ enabled: true, raw: '', requested: [], ignored: [], inactive: [], effective: [] })
    expect(config.legacy || config.noRecog || config.noMeter || config.trace).toBe(false)
  })

  it('ignores unknown names (typos and different cases)', () => {
    const config = readExperimentConfig('?exp=norecg,NoRecog,nometer')
    expect(config.ignored).toEqual(['norecg', 'NoRecog'])
    expect(config.requested).toEqual(['nometer'])
    expect(config.effective).toEqual(['nometer'])
    expect(config.noRecog).toBe(false)
  })

  it.each([
    ['legacy', 'legacy'],
    ['norecog', 'noRecog'],
    ['legacyrecog', 'legacyRecog'],
    ['nometer', 'noMeter'],
    ['nodisconnect', 'noDisconnect'],
    ['awaitclose', 'awaitClose'],
    ['notrackread', 'noTrackRead'],
    ['noendedlistener', 'noEndedListener'],
    ['nolifecycle', 'noLifecycle'],
    ['trace', 'trace'],
  ] as const)('turns on %s alone', (name, key) => {
    const config = readExperimentConfig(`?exp=${name}`)
    expect(config.effective).toEqual([name])
    expect(config[key]).toBe(true)
    const others = (['legacy', 'noRecog', 'legacyRecog', 'noMeter', 'noDisconnect', 'awaitClose', 'noTrackRead', 'noEndedListener', 'noLifecycle', 'trace'] as const)
      .filter(k => k !== key)
    others.forEach(k => expect(config[k]).toBe(false))
  })

  it('uses legacy alone and makes the others (trace too) inactive', () => {
    const config = readExperimentConfig('?exp=norecog,legacy,trace,typo')
    expect(config.effective).toEqual(['legacy'])
    expect(config.legacy).toBe(true)
    expect(config.noRecog).toBe(false)
    expect(config.trace).toBe(false)
    expect(config.inactive).toEqual([
      { name: 'norecog', reason: 'legacy と組み合わせない' },
      { name: 'trace', reason: 'legacy と組み合わせない' },
    ])
    expect(config.ignored).toEqual(['typo'])
  })

  it('prefers norecog over legacyrecog', () => {
    const config = readExperimentConfig('?exp=legacyrecog,norecog')
    expect(config.effective).toEqual(['norecog'])
    expect(config.noRecog).toBe(true)
    expect(config.legacyRecog).toBe(false)
    expect(config.inactive).toEqual([{ name: 'legacyrecog', reason: 'norecog が優先' }])
  })

  it('prefers nometer over nodisconnect and awaitclose', () => {
    const config = readExperimentConfig('?exp=nodisconnect,awaitclose,nometer')
    expect(config.effective).toEqual(['nometer'])
    expect(config.noDisconnect).toBe(false)
    expect(config.awaitClose).toBe(false)
    expect(config.inactive).toEqual([
      { name: 'nodisconnect', reason: 'nometer が優先' },
      { name: 'awaitclose', reason: 'nometer が優先' },
    ])
  })

  it('uses nodisconnect and awaitclose together', () => {
    const config = readExperimentConfig('?exp=nodisconnect,awaitclose')
    expect(config.effective).toEqual(['nodisconnect', 'awaitclose'])
    expect(config.noDisconnect).toBe(true)
    expect(config.awaitClose).toBe(true)
    expect(config.inactive).toEqual([])
  })

  it('removes duplicates', () => {
    const config = readExperimentConfig('?exp=trace,trace,x,x')
    expect(config.requested).toEqual(['trace'])
    expect(config.ignored).toEqual(['x'])
  })

  it('keeps the parsed value as it is when resolving a disabled query', () => {
    expect(resolveExperimentConfig({ enabled: false, raw: null, names: [] })).toBe(DEFAULT_EXPERIMENT_CONFIG)
  })
})

// 2回目の実験のスイッチ（recogfirst、recogabort、recogdelay、recogearly、recogonce）の指定と組み合わせ
describe('resolveExperimentConfig: the second experiment', () => {
  const ALL_KEYS = ['legacy', 'noRecog', 'legacyRecog', 'noMeter', 'noDisconnect', 'awaitClose', 'noTrackRead', 'noEndedListener', 'noLifecycle', 'trace',
    'recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const

  it.each([
    ['recogfirst', 'recogFirst'],
    ['recogabort', 'recogAbort'],
    ['recogearly', 'recogEarly'],
    ['recogonce', 'recogOnce'],
  ] as const)('turns on %s alone', (name, key) => {
    const config = readExperimentConfig(`?exp=${name}`)
    expect(config.effective).toEqual([name])
    expect(config.inactive).toEqual([])
    expect(config[key]).toBe(true)
    ALL_KEYS.filter(k => k !== key).forEach(k => expect(config[k]).toBe(false))
  })

  it('keeps all the new switches off without exp and with an empty exp', () => {
    ;(['recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const).forEach(k => {
      expect(DEFAULT_EXPERIMENT_CONFIG[k]).toBe(false)
      expect(readExperimentConfig('?exp=')[k]).toBe(false)
    })
  })

  it('makes recogdelay inactive without recogfirst', () => {
    const config = readExperimentConfig('?exp=recogdelay')
    expect(config.effective).toEqual([])
    expect(config.recogDelay).toBe(false)
    expect(config.inactive).toEqual([{ name: 'recogdelay', reason: 'recogfirst と一緒のときだけ効く' }])
    expect(readExperimentConfig('?exp=recogdelay,recogabort').inactive).toEqual([{ name: 'recogdelay', reason: 'recogfirst と一緒のときだけ効く' }])
  })

  it('uses recogdelay with recogfirst', () => {
    const config = readExperimentConfig('?exp=recogdelay,recogfirst')
    expect(config.effective).toEqual(['recogdelay', 'recogfirst'])
    expect(config.recogDelay).toBe(true)
    expect(config.recogFirst).toBe(true)
    expect(config.inactive).toEqual([])
  })

  it('prefers norecog over all the recognition switches', () => {
    const config = readExperimentConfig('?exp=recogfirst,recogabort,recogdelay,recogearly,recogonce,legacyrecog,norecog,nometer')
    expect(config.effective).toEqual(['norecog', 'nometer'])
    ;(['recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce', 'legacyRecog'] as const).forEach(k => expect(config[k]).toBe(false))
    expect(config.inactive).toEqual(['recogfirst', 'recogabort', 'recogdelay', 'recogearly', 'recogonce', 'legacyrecog'].map(name => ({ name, reason: 'norecog が優先' })))
  })

  it('uses recogfirst and recogabort together', () => {
    const config = readExperimentConfig('?exp=recogfirst,recogabort')
    expect(config.effective).toEqual(['recogfirst', 'recogabort'])
    expect(config.recogFirst && config.recogAbort).toBe(true)
    expect(config.inactive).toEqual([])
  })

  it('uses recogfirst and awaitclose together, but nometer still turns awaitclose off', () => {
    const config = readExperimentConfig('?exp=recogfirst,awaitclose')
    expect(config.effective).toEqual(['recogfirst', 'awaitclose'])
    expect(config.recogFirst && config.awaitClose).toBe(true)
    const withMeterOff = readExperimentConfig('?exp=recogfirst,awaitclose,nometer')
    expect(withMeterOff.effective).toEqual(['recogfirst', 'nometer'])
    expect(withMeterOff.inactive).toEqual([{ name: 'awaitclose', reason: 'nometer が優先' }])
  })

  it('uses legacy alone and makes the new switches inactive', () => {
    const config = readExperimentConfig('?exp=legacy,recogfirst,recogabort,recogdelay,recogearly,recogonce')
    expect(config.effective).toEqual(['legacy'])
    ;(['recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const).forEach(k => expect(config[k]).toBe(false))
    expect(config.inactive.map(i => i.name)).toEqual(['recogfirst', 'recogabort', 'recogdelay', 'recogearly', 'recogonce'])
    expect(config.inactive.every(i => i.reason === 'legacy と組み合わせない')).toBe(true)
  })

  it('prefers recogfirst, recogabort, recogearly and recogonce over legacyrecog', () => {
    const config = readExperimentConfig('?exp=legacyrecog,recogonce,recogfirst')
    expect(config.effective).toEqual(['recogonce', 'recogfirst'])
    expect(config.legacyRecog).toBe(false)
    expect(config.inactive).toEqual([{ name: 'legacyrecog', reason: 'recogfirst、recogonce が優先' }])
    expect(readExperimentConfig('?exp=legacyrecog,recogabort').inactive).toEqual([{ name: 'legacyrecog', reason: 'recogabort が優先' }])
    expect(readExperimentConfig('?exp=legacyrecog,recogearly').inactive).toEqual([{ name: 'legacyrecog', reason: 'recogearly が優先' }])
  })

  it('keeps legacyrecog with recogdelay alone (recogdelay is inactive)', () => {
    const config = readExperimentConfig('?exp=legacyrecog,recogdelay')
    expect(config.effective).toEqual(['legacyrecog'])
    expect(config.inactive).toEqual([{ name: 'recogdelay', reason: 'recogfirst と一緒のときだけ効く' }])
  })
})

// 3回目の実験のスイッチ（legacykeep）の指定と組み合わせ
describe('resolveExperimentConfig: legacykeep', () => {
  const ALL_KEYS = ['legacy', 'legacyKeep', 'noRecog', 'legacyRecog', 'noMeter', 'noDisconnect', 'awaitClose', 'noTrackRead', 'noEndedListener', 'noLifecycle', 'trace',
    'recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const

  it('keeps legacykeep off without exp and with an empty exp', () => {
    expect(DEFAULT_EXPERIMENT_CONFIG.legacyKeep).toBe(false)
    expect(readExperimentConfig('?exp=').legacyKeep).toBe(false)
  })

  it('turns on legacykeep alone', () => {
    const config = readExperimentConfig('?exp=legacykeep')
    expect(config.effective).toEqual(['legacykeep'])
    expect(config.inactive).toEqual([])
    expect(config.legacyKeep).toBe(true)
    ALL_KEYS.filter(k => k !== 'legacyKeep').forEach(k => expect(config[k]).toBe(false))
  })

  it('prefers legacykeep over legacy in either order', () => {
    for (const search of ['?exp=legacy,legacykeep', '?exp=legacykeep,legacy']) {
      const config = readExperimentConfig(search)
      expect(config.effective).toEqual(['legacykeep'])
      expect(config.legacyKeep).toBe(true)
      expect(config.legacy).toBe(false)
      expect(config.inactive).toEqual([{ name: 'legacy', reason: 'legacykeep が優先（legacykeep は legacy にマイクの使い回しを加えたもの）' }])
    }
  })

  it('uses legacykeep alone and makes the others (trace too) inactive', () => {
    const config = readExperimentConfig('?exp=norecog,legacykeep,trace,recogonce,legacy,typo')
    expect(config.effective).toEqual(['legacykeep'])
    expect(config.ignored).toEqual(['typo'])
    expect(config.inactive).toEqual([
      { name: 'norecog', reason: 'legacykeep と組み合わせない' },
      { name: 'trace', reason: 'legacykeep と組み合わせない' },
      { name: 'recogonce', reason: 'legacykeep と組み合わせない' },
      { name: 'legacy', reason: 'legacykeep が優先（legacykeep は legacy にマイクの使い回しを加えたもの）' },
    ])
    ALL_KEYS.filter(k => k !== 'legacyKeep').forEach(k => expect(config[k]).toBe(false))
  })

  it('ignores legacykeep in a different case', () => {
    const config = readExperimentConfig('?exp=LegacyKeep,legacy')
    expect(config.ignored).toEqual(['LegacyKeep'])
    expect(config.effective).toEqual(['legacy'])
    expect(config.legacyKeep).toBe(false)
  })
})

// 4回目の実験のスイッチ（legacymute）の指定と組み合わせ
describe('resolveExperimentConfig: legacymute', () => {
  const ALL_KEYS = ['legacy', 'legacyKeep', 'legacyMute', 'noRecog', 'legacyRecog', 'noMeter', 'noDisconnect', 'awaitClose', 'noTrackRead', 'noEndedListener', 'noLifecycle', 'trace',
    'recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const
  const OVER_LEGACY = 'legacymute が優先（legacymute は legacykeep に track の無効と有効を加えたもの）'

  it('keeps legacymute off without exp, with an empty exp and with legacykeep', () => {
    expect(DEFAULT_EXPERIMENT_CONFIG.legacyMute).toBe(false)
    expect(readExperimentConfig('?exp=').legacyMute).toBe(false)
    expect(readExperimentConfig('?exp=legacykeep').legacyMute).toBe(false)
    expect(readExperimentConfig('?exp=legacy').legacyMute).toBe(false)
  })

  it('turns on legacymute alone with legacyKeep', () => {
    const config = readExperimentConfig('?exp=legacymute')
    expect(config.effective).toEqual(['legacymute'])
    expect(config.inactive).toEqual([])
    expect(config.legacyMute).toBe(true)
    expect(config.legacyKeep).toBe(true)
    expect(config.legacy).toBe(false)
    ALL_KEYS.filter(k => k !== 'legacyMute' && k !== 'legacyKeep').forEach(k => expect(config[k]).toBe(false))
  })

  it('prefers legacymute over legacy and legacykeep in any order', () => {
    for (const search of ['?exp=legacy,legacykeep,legacymute', '?exp=legacymute,legacykeep,legacy', '?exp=legacykeep,legacymute,legacy']) {
      const config = readExperimentConfig(search)
      expect(config.effective).toEqual(['legacymute'])
      expect(config.legacyMute).toBe(true)
      expect(config.legacyKeep).toBe(true)
      expect(config.legacy).toBe(false)
      expect(config.inactive).toEqual(config.requested.filter(n => n !== 'legacymute').map(name => ({ name, reason: OVER_LEGACY })))
    }
  })

  it('uses legacymute alone and makes the others (trace too) inactive', () => {
    const config = readExperimentConfig('?exp=norecog,legacymute,trace,recogonce,legacykeep,typo,legacy')
    expect(config.effective).toEqual(['legacymute'])
    expect(config.ignored).toEqual(['typo'])
    expect(config.inactive).toEqual([
      { name: 'norecog', reason: 'legacymute と組み合わせない' },
      { name: 'trace', reason: 'legacymute と組み合わせない' },
      { name: 'recogonce', reason: 'legacymute と組み合わせない' },
      { name: 'legacykeep', reason: OVER_LEGACY },
      { name: 'legacy', reason: OVER_LEGACY },
    ])
    ALL_KEYS.filter(k => k !== 'legacyMute' && k !== 'legacyKeep').forEach(k => expect(config[k]).toBe(false))
  })

  it('ignores legacymute in a different case', () => {
    const config = readExperimentConfig('?exp=LegacyMute,legacykeep')
    expect(config.ignored).toEqual(['LegacyMute'])
    expect(config.effective).toEqual(['legacykeep'])
    expect(config.legacyMute).toBe(false)
    expect(config.legacyKeep).toBe(true)
  })
})

// 5回目の実験のスイッチ（recogonly）の指定と組み合わせ
describe('resolveExperimentConfig: recogonly', () => {
  const ALL_KEYS = ['legacy', 'legacyKeep', 'legacyMute', 'recogOnly', 'noRecog', 'legacyRecog', 'noMeter', 'noDisconnect', 'awaitClose', 'noTrackRead', 'noEndedListener', 'noLifecycle', 'trace',
    'recogFirst', 'recogAbort', 'recogDelay', 'recogEarly', 'recogOnce'] as const

  it('keeps recogonly off by default', () => {
    expect(DEFAULT_EXPERIMENT_CONFIG.recogOnly).toBe(false)
    expect(readExperimentConfig('?exp=').recogOnly).toBe(false)
    expect(readExperimentConfig('?exp=legacymute').recogOnly).toBe(false)
  })

  it('turns on recogonly alone', () => {
    const config = readExperimentConfig('?exp=recogonly')
    expect(config.effective).toEqual(['recogonly'])
    expect(config.inactive).toEqual([])
    ALL_KEYS.forEach(k => expect(config[k]).toBe(k === 'recogOnly'))
  })

  it('prefers recogonly over legacymute, legacykeep, legacy and makes the others inactive', () => {
    const config = readExperimentConfig('?exp=legacymute,trace,recogonly,legacykeep,legacy')
    expect(config.effective).toEqual(['recogonly'])
    expect(config.inactive).toEqual(['legacymute', 'trace', 'legacykeep', 'legacy'].map(name => ({ name, reason: 'recogonly と組み合わせない' })))
    ALL_KEYS.forEach(k => expect(config[k]).toBe(k === 'recogOnly'))
  })
})
