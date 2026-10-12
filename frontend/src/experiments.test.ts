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
