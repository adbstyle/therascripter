import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'fs'
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
}

export function downloadFile(
  url: string,
  targetPath: string,
  onProgress: (progress: DownloadProgress) => void,
  abortSignal?: { aborted: boolean }
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

    const request = getter(url, { headers }, (response: IncomingMessage) => {
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          response.destroy()
          downloadFile(redirectUrl, targetPath, onProgress, abortSignal).then(resolve)
          return
        }
      }

      // If server doesn't support Range, start over
      if (response.statusCode === 200 && existingBytes > 0) {
        existingBytes = 0
      }

      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.destroy()
        resolve({ success: false, error: `HTTP ${response.statusCode}` })
        return
      }

      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10)
      const totalBytes = existingBytes + contentLength

      const fileStream = createWriteStream(partialPath, {
        flags: existingBytes > 0 && response.statusCode === 206 ? 'a' : 'w'
      })

      let downloaded = existingBytes

      response.on('data', (chunk: Buffer) => {
        if (abortSignal?.aborted) {
          response.destroy()
          fileStream.end()
          resolve({ success: false, error: 'Aborted' })
          return
        }

        downloaded += chunk.length
        onProgress({
          downloadedBytes: downloaded,
          totalBytes,
          percent: totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
        })
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        if (abortSignal?.aborted) {
          resolve({ success: false, error: 'Aborted' })
          return
        }
        // Move partial to final path
        renameSync(partialPath, targetPath)
        resolve({ success: true })
      })

      fileStream.on('error', (err) => {
        response.destroy()
        resolve({ success: false, error: err.message })
      })
    })

    request.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    request.setTimeout(30000, () => {
      request.destroy()
      resolve({ success: false, error: 'Connection timeout' })
    })
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

export function cleanupPartial(targetPath: string): void {
  const partialPath = targetPath + '.partial'
  try {
    if (existsSync(partialPath)) unlinkSync(partialPath)
  } catch {
    // Ignore cleanup errors
  }
}
