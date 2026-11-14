import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

const mockCleanupSourceFiles = vi.fn().mockReturnValue(0)
vi.mock('../SessionService', () => ({
  SessionService: vi.fn().mockImplementation(() => ({
    cleanupSourceFiles: mockCleanupSourceFiles
  }))
}))

vi.mock('../../db/connection', () => ({
  getDatabase: () => ({}),
  getDataDir: () => '/mock/home/.therascript'
}))

import { startSourceFileCleanup, stopSourceFileCleanup } from '../SourceFileCleanupService'

describe('SourceFileCleanupService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopSourceFileCleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('runs the source-file cleanup immediately on start', () => {
    startSourceFileCleanup()
    expect(mockCleanupSourceFiles).toHaveBeenCalledOnce()
  })

  it('runs the source-file cleanup every 6 hours', () => {
    startSourceFileCleanup()
    mockCleanupSourceFiles.mockClear()

    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(mockCleanupSourceFiles).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(mockCleanupSourceFiles).toHaveBeenCalledTimes(2)
  })

  it('does not start twice', () => {
    startSourceFileCleanup()
    startSourceFileCleanup()
    expect(mockCleanupSourceFiles).toHaveBeenCalledOnce()
  })

  it('stops the interval', () => {
    startSourceFileCleanup()
    stopSourceFileCleanup()
    mockCleanupSourceFiles.mockClear()

    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(mockCleanupSourceFiles).not.toHaveBeenCalled()
  })

  // Issue #202: the periodic run only removes source files. The mocked
  // SessionService offers nothing else — any other call would throw and be
  // logged as a failure.
  it('touches nothing but source files', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startSourceFileCleanup()
    expect(mockCleanupSourceFiles).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
