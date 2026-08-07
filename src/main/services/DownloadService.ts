import { createHash } from 'crypto'
import { execFile } from 'child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { get as httpsGet } from 'https'
import { get as httpGet, type IncomingMessage } from 'http'

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

export interface DownloadResult {
  success: boolean
  error?: string
  /**
   * SHA-256 des heruntergeladenen Inhalts, beim Streamen mitberechnet —
   * erspart den zweiten Full-Read von verifyFileSha256 (2.4 GB beim
   * First-Launch). Undefined bei Resume (Hash-State des Partials unbekannt)
   * — Caller fällt dann auf verifyFileSha256 zurück.
   */
  sha256?: string
}

const MAX_REDIRECTS = 5

export function downloadFile(
  url: string,
  targetPath: string,
  onProgress: (progress: DownloadProgress) => void,
  abortSignal?: { aborted: boolean },
  redirectsLeft = MAX_REDIRECTS
): Promise<DownloadResult> {
  const partialPath = targetPath + '.partial'

  return new Promise((resolve) => {
    let existingBytes = 0
    if (existsSync(partialPath)) {
      existingBytes = statSync(partialPath).size
    }

    const headers: Record<string, string> = {}
    if (existingBytes > 0) {
      headers['Range'] = `bytes=${existingBytes}-`
    }

    const getter = url.startsWith('https') ? httpsGet : httpGet

    // settle() statt nacktem resolve: mehrere Callbacks (data/finish/error/
    // timeout/abort-Poll) können konkurrieren; der erste gewinnt und räumt
    // den Abort-Poll ab.
    let settled = false
    let abortPoll: ReturnType<typeof setInterval> | null = null
    const settle = (result: DownloadResult): void => {
      if (settled) return
      settled = true
      if (abortPoll !== null) clearInterval(abortPoll)
      resolve(result)
    }

    const request = getter(url, { headers }, (response: IncomingMessage) => {
      // Handle redirects — mit Hop-Limit (eine Redirect-Schleife rekursierte
      // vorher unbounded) und relativer Location-Auflösung (R2/CDNs dürfen
      // relative Redirects schicken; vorher hing der Download).
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        if (location) {
          response.destroy()
          if (redirectsLeft <= 0) {
            settle({ success: false, error: `Zu viele Redirects (Limit ${MAX_REDIRECTS})` })
            return
          }
          let redirectUrl: string
          try {
            redirectUrl = new URL(location, url).toString()
          } catch {
            settle({ success: false, error: `Ungültige Redirect-URL: ${location}` })
            return
          }
          downloadFile(redirectUrl, targetPath, onProgress, abortSignal, redirectsLeft - 1).then(
            settle
          )
          return
        }
      }

      // If server doesn't support Range, start over
      if (response.statusCode === 200 && existingBytes > 0) {
        existingBytes = 0
      }

      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.destroy()
        settle({ success: false, error: `HTTP ${response.statusCode}` })
        return
      }

      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10)
      const totalBytes = existingBytes + contentLength

      const isResume = existingBytes > 0 && response.statusCode === 206
      // Hash beim Streamen mitberechnen — nur bei Fresh-Downloads; bei Resume
      // ist der Hash-State des bestehenden Partials unbekannt.
      const streamHash = isResume ? null : createHash('sha256')

      const fileStream = createWriteStream(partialPath, {
        flags: isResume ? 'a' : 'w'
      })

      let downloaded = existingBytes

      // Throttle auf ~4 Hz (Muster von TaskQueueService): ungedrosselt
      // feuerte onProgress pro HTTP-Chunk — ~37 000 Events für den 2.4-GB-
      // First-Launch-Download, jeder davon ein IPC-Send + Renderer-Rerender.
      // Der finale Zustand (downloaded === totalBytes) kommt immer durch.
      const PROGRESS_THROTTLE_MS = 250
      let lastProgressEmit = 0

      response.on('data', (chunk: Buffer) => {
        if (abortSignal?.aborted) {
          response.destroy()
          fileStream.end()
          settle({ success: false, error: 'Aborted' })
          return
        }

        downloaded += chunk.length
        streamHash?.update(chunk)
        const now = Date.now()
        const isFinal = totalBytes > 0 && downloaded >= totalBytes
        if (isFinal || now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
          lastProgressEmit = now
          onProgress({
            downloadedBytes: downloaded,
            totalBytes,
            percent: totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
          })
        }
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        if (abortSignal?.aborted) {
          settle({ success: false, error: 'Aborted' })
          return
        }
        // Move partial to final path. try/catch zwingend: ein Throw hier
        // (EXDEV/EACCES/ENOENT) war eine uncaught exception im
        // Stream-Callback — das Promise settlete nie und der wartende
        // startModelDownload hing für immer.
        try {
          renameSync(partialPath, targetPath)
          settle({ success: true, sha256: streamHash?.digest('hex') })
        } catch (err) {
          settle({
            success: false,
            error: `Datei konnte nicht finalisiert werden: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      })

      fileStream.on('error', (err) => {
        response.destroy()
        settle({ success: false, error: err.message })
      })
    })

    request.on('error', (err) => {
      settle({ success: false, error: err.message })
    })

    request.setTimeout(30000, () => {
      request.destroy()
      settle({ success: false, error: 'Connection timeout' })
    })

    // Abort-Poll: der data-Handler sieht das Abort-Flag nur, solange Bytes
    // fliessen — bei gestallter Verbindung griff »Abbrechen« vorher erst
    // nach dem 30-s-Socket-Timeout.
    if (abortSignal) {
      abortPoll = setInterval(() => {
        if (abortSignal.aborted) {
          request.destroy()
          settle({ success: false, error: 'Aborted' })
        }
      }, 250)
    }
  })
}

export async function verifyFileSha256(filePath: string, expectedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)

    stream.on('data', (data) => hash.update(data))
    stream.on('end', () => resolve(hash.digest('hex') === expectedHash))
    stream.on('error', () => resolve(false))
  })
}

export function extractTarGz(archivePath: string, targetDir: string): Promise<DownloadResult> {
  return new Promise((resolve) => {
    execFile('tar', ['-xzf', archivePath, '-C', targetDir], (error) => {
      if (error) {
        resolve({ success: false, error: `Extraction fehlgeschlagen: ${error.message}` })
        return
      }
      // Clean up archive after successful extraction
      try {
        unlinkSync(archivePath)
      } catch {
        // Non-fatal
      }
      resolve({ success: true })
    })
  })
}
