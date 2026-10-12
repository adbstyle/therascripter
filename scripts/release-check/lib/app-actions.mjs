/**
 * Handlungen in der App über ihre reguläre Renderer-API (`window.api.*`) —
 * derselbe IPC-Vertrag wie ein Klick. Gemeinsam für Seed-Aufbau (Vorversion)
 * und Prüfung (neue Version), deshalb nur API, die beide Versionen haben.
 */
import { readFileSync } from 'fs'
import { waitFor } from './instance.mjs'

const json = (value) => JSON.stringify(value)

/** PCM aus einer WAV im Aufnahmeformat (48 kHz mono 16-bit, 44-Byte-Header). */
function readPcm(wavPath) {
  const wav = readFileSync(wavPath)
  return wav.subarray(wav.indexOf(Buffer.from('data')) + 8)
}

/**
 * Startet eine Aufnahme und speist PCM über recording:data ein — der Weg, den
 * sonst der Mikrofon-Worklet nimmt (getUserMedia selbst läuft nicht, die
 * Release-Prüfung braucht so keine Mikrofon-Berechtigung).
 * @returns {Promise<string>} sessionId
 */
export async function startRecording(page, wavPath, { seconds } = {}) {
  let pcm = readPcm(wavPath)
  if (seconds) pcm = pcm.subarray(0, Math.min(pcm.length, seconds * 48000 * 2))
  const { sessionId } = await page.eval('window.api.recording.start()')
  const chunkSamples = 48000
  for (let offset = 0; offset < pcm.length / 2; offset += chunkSamples) {
    const end = Math.min(pcm.length / 2, offset + chunkSamples)
    const b64 = pcm.subarray(offset * 2, end * 2).toString('base64')
    await page.eval(`(() => {
      const bin = atob(${json(b64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const int16 = new Int16Array(bytes.buffer)
      const f32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
      window.api.recording.sendData(${json(sessionId)}, f32.buffer)
      return true
    })()`)
  }
  return sessionId
}

export async function stopRecording(page, sessionId) {
  return page.eval(`window.api.recording.stop(${json(sessionId)})`)
}

/** Importiert ein PDF und liefert die neue sessionId. */
export async function importPdf(page, pdfPath) {
  const before = new Set((await listSessions(page)).map((s) => s.id))
  await page.eval(`window.api.import.pdf([${json(pdfPath)}])`)
  const created = await waitFor(
    async () => (await listSessions(page)).find((s) => !before.has(s.id) && s.type === 'pdf'),
    { what: `PDF-Import von ${pdfPath}`, timeoutMs: 30_000, intervalMs: 500 }
  )
  return created.id
}

export function listSessions(page) {
  return page.eval('window.api.sessions.list()')
}

/**
 * Wartet, bis eine Sitzung fertig verarbeitet ist — «review» UND keine
 * offene Aufgabe der Sitzung mehr (die Zusammenfassung läuft nach «review» im
 * Hintergrund weiter). Eine fehlende Zusammenfassung ist ein Fehler: Die
 * App überspringt sie bei Problemen still, die Release-Prüfung darf das nicht.
 */
export async function waitUntilProcessed(page, sessionId, { label, timeoutMs }) {
  let last
  await waitFor(
    async () => {
      const session = (await listSessions(page)).find((s) => s.id === sessionId)
      last = session
      if (!session) throw new Error(`${label}: Sitzung ${sessionId} verschwunden`)
      if (session.status === 'error') {
        throw new Error(
          `${label}: Verarbeitung gescheitert — ${session.errorMessage ?? 'ohne Meldung'}`
        )
      }
      if (session.status !== 'review') return false
      // Nicht isProcessing(): das ist zwischen zwei Schritten kurz false.
      const tasks = await page.eval(`window.api.tasks.getSessionTasks(${json(sessionId)})`)
      return tasks.every((t) => t.status !== 'pending' && t.status !== 'running')
    },
    { what: `${label}: Verarbeitung bis «review»`, timeoutMs, intervalMs: 3000 }
  )
  if (!last.summary) {
    throw new Error(`${label}: keine Zusammenfassung — Zusammenfassungs-Schritt still übersprungen`)
  }
  return last
}
