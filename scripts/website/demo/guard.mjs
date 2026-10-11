import { homedir } from 'os'
import { join } from 'path'

/**
 * Bricht ab, wenn die per CDP verbundene Instanz mit den echten Daten unter
 * ~/.therascript läuft (z. B. die gepackte App der E2E-Tests auf Port 9223).
 * Demo-Werkzeuge schreiben, löschen und fotografieren — nie auf echten Daten.
 */
export async function assertDemoInstance(evalInApp) {
  const { dataDir } = await evalInApp('window.api.system.aboutInfo()')
  if (!dataDir || dataDir === join(homedir(), '.therascript')) {
    throw new Error(
      `Abbruch: Die Instanz auf CDP-Port ${process.env.CDP_PORT ?? '9223'} nutzt die echten ` +
        `Daten (${dataDir}). Demo-Instanz mit start-demo-instance.sh starten und CDP_PORT=9224 setzen.`
    )
  }
}
