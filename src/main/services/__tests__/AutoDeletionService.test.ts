import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

const mockCleanupOldSessions = vi.fn().mockReturnValue(0)
const mockCleanupSourceFiles = vi.fn().mockReturnValue(0)
vi.mock('../SessionService', () => ({
  SessionService: vi.fn().mockImplementation(() => ({
    cleanupOldSessions: mockCleanupOldSessions,
    cleanupSourceFiles: mockCleanupSourceFiles
  }))
}))

const mockDb = {
  pragma: vi.fn(),
  exec: vi.fn()
}
vi.mock('../../db/connection', () => ({
  getDatabase: () => mockDb,
  getDataDir: () => '/mock/home/.therascript'
}))

const mockFileExists = vi.fn().mockReturnValue(false)
const mockWriteFile = vi.fn()
vi.mock('../../utils/file-ops', () => ({
  fileExists: (...args: unknown[]) => mockFileExists(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args)
}))

import {
  startAutoDeletion,
  stopAutoDeletion,
  ensureSpotlightExclusion
} from '../AutoDeletionService'

describe('AutoDeletionService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopAutoDeletion()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('calls cleanupSourceFiles on each cleanup run', () => {
    startAutoDeletion()
    expect(mockCleanupSourceFiles).toHaveBeenCalledOnce()
  })

  describe('startAutoDeletion', () => {
    it('runs cleanup immediately on start', () => {
      startAutoDeletion()
      expect(mockCleanupOldSessions).toHaveBeenCalledOnce()
    })

    it('runs cleanup every 6 hours', () => {
      startAutoDeletion()
      mockCleanupOldSessions.mockClear()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
      expect(mockCleanupOldSessions).toHaveBeenCalledOnce()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
      expect(mockCleanupOldSessions).toHaveBeenCalledTimes(2)
    })

    it('does not start twice', () => {
      startAutoDeletion()
      startAutoDeletion()
      expect(mockCleanupOldSessions).toHaveBeenCalledOnce()
    })
  })

  describe('stopAutoDeletion', () => {
    it('stops the interval', () => {
      startAutoDeletion()
      stopAutoDeletion()
      mockCleanupOldSessions.mockClear()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
      expect(mockCleanupOldSessions).not.toHaveBeenCalled()
    })
  })

  describe('ensureSpotlightExclusion', () => {
    it('creates .metadata_never_index if not present', () => {
      mockFileExists.mockReturnValue(false)

      ensureSpotlightExclusion()

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/mock/home/.therascript/.metadata_never_index',
        '',
        0o600
      )
    })

    it('does not create file if already present', () => {
      mockFileExists.mockReturnValue(true)

      ensureSpotlightExclusion()

      expect(mockWriteFile).not.toHaveBeenCalled()
    })
  })
})
