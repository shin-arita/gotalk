import { describe, it, expect } from 'vitest'
import { API_TIMEOUT_MS, apiErrorMessage } from './api'

function res(body: unknown, json = true): Response {
  return {
    json: () => (json ? Promise.resolve(body) : Promise.reject(new SyntaxError('not json'))),
  } as unknown as Response
}

describe('API_TIMEOUT_MS', () => {
  it('is longer than the backend deadlines (55s / 25s / 25s) and nginx (60s) for interpret', () => {
    expect(API_TIMEOUT_MS.interpret).toBe(65_000)
    expect(API_TIMEOUT_MS.translate).toBe(30_000)
    expect(API_TIMEOUT_MS.tts).toBe(30_000)
  })
})

describe('apiErrorMessage', () => {
  it('returns the message for a known code', async () => {
    expect(await apiErrorMessage(res({ error: 'x', code: 'upstream_busy' }))).toBe('混み合っています。しばらくしてからお試しください')
  })

  it('returns null for unknown codes, a missing code, and non-JSON bodies', async () => {
    expect(await apiErrorMessage(res({ error: 'x', code: 'insufficient_quota' }))).toBeNull()
    expect(await apiErrorMessage(res({ error: 'x' }))).toBeNull()
    expect(await apiErrorMessage(res({ error: 'x', code: 'toString' }))).toBeNull()
    expect(await apiErrorMessage(res(null))).toBeNull()
    expect(await apiErrorMessage(res('text'))).toBeNull()
    expect(await apiErrorMessage(res(undefined, false))).toBeNull()
  })
})
