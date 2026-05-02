import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHANNELS, getChannel, _resetChannelCacheForTests } from '../Channel'

const ENV_KEY = 'THERASCRIPT_CHANNEL'

describe('Channel — Issue #84 Story D', () => {
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_KEY]
    _resetChannelCacheForTests()
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalValue
    }
    _resetChannelCacheForTests()
  })

  it('lists prod, staging, local as the supported channels', () => {
    expect(CHANNELS).toEqual(['prod', 'staging', 'local'])
  })

  it('defaults to prod when the env var is unset', () => {
    delete process.env[ENV_KEY]
    expect(getChannel()).toBe('prod')
  })

  it('returns the env-supplied channel when valid', () => {
    process.env[ENV_KEY] = 'staging'
    expect(getChannel()).toBe('staging')

    _resetChannelCacheForTests()
    process.env[ENV_KEY] = 'local'
    expect(getChannel()).toBe('local')
  })

  it('falls back to prod for unknown values', () => {
    process.env[ENV_KEY] = 'mainnet'
    expect(getChannel()).toBe('prod')
  })

  it('caches the resolved channel (env changes mid-process are ignored)', () => {
    process.env[ENV_KEY] = 'staging'
    expect(getChannel()).toBe('staging')

    process.env[ENV_KEY] = 'local'
    // Without _resetChannelCacheForTests, the cached value sticks.
    expect(getChannel()).toBe('staging')
  })
})
