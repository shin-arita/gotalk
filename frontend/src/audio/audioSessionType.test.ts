import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { declarePlayAndRecord } from './audioSessionType'
import { removeAudioSessionType, saveGlobals, setupAudioSessionType } from '../test/audioMocks'

// 音の扱い（navigator.audioSession.type）の宣言（GOTALK-17、docs/speech-flow.md の「9. TTS」）

let restoreGlobals: () => void

beforeEach(() => {
  restoreGlobals = saveGlobals([[globalThis.navigator, 'audioSession']])
})

afterEach(() => {
  restoreGlobals()
})

describe('declarePlayAndRecord', () => {
  it('sets play-and-record and returns the value after setting', () => {
    const audioSession = setupAudioSessionType()
    expect(declarePlayAndRecord()).toEqual({ kind: 'set', type: 'play-and-record' })
    expect(audioSession.setType).toHaveBeenCalledWith('play-and-record')
    expect(audioSession.type).toBe('play-and-record')
  })

  it('is idempotent: does not set it again when it is already play-and-record', () => {
    const audioSession = setupAudioSessionType()
    declarePlayAndRecord()
    expect(declarePlayAndRecord()).toEqual({ kind: 'set', type: 'play-and-record' })
    expect(audioSession.setType).toHaveBeenCalledTimes(1)
  })

  it('returns the value the browser kept, even if it ignored the setting', () => {
    const audioSession = setupAudioSessionType()
    audioSession.setType.mockImplementation(() => {})
    expect(declarePlayAndRecord()).toEqual({ kind: 'set', type: 'auto' })
  })

  it('does nothing and returns unsupported without navigator.audioSession', () => {
    removeAudioSessionType()
    expect(declarePlayAndRecord()).toEqual({ kind: 'unsupported' })
  })

  it('returns unsupported when navigator.audioSession is null', () => {
    Object.defineProperty(globalThis.navigator, 'audioSession', { value: null, configurable: true })
    expect(declarePlayAndRecord()).toEqual({ kind: 'unsupported' })
  })

  it('does not throw and returns the error name when the setter throws', () => {
    setupAudioSessionType({ throwOnSet: true })
    expect(declarePlayAndRecord()).toEqual({ kind: 'failed', errorName: 'InvalidStateError' })
  })

  it('does not throw when reading navigator.audioSession throws', () => {
    Object.defineProperty(globalThis.navigator, 'audioSession', { get: () => { throw new TypeError('boom') }, configurable: true })
    expect(declarePlayAndRecord()).toEqual({ kind: 'failed', errorName: 'TypeError' })
  })
})
