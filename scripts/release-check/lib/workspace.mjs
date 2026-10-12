/**
 * Arbeitsverzeichnisse, Vorversion und Datenbank-Helfer der Release-Prüfung.
 *
 * Alles liegt unter ~/Library/Caches/therascript-release-check/. Die
 * Datenbank speichert absolute Dateipfade (SessionService), ein Seed ist
 * deshalb nur unter dem Home gültig, unter dem er gebaut wurde: Bau und
 * Prüfung verwenden immer dasselbe SEED_HOME.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const BASE = join(homedir(), 'Library', 'Caches', 'therascript-release-check')
export const SEED_HOME = join(BASE, 'home')
export const FRESH_HOME = join(BASE, 'fresh-home')
export const LOG_DIR = join(BASE, 'logs')

const REAL_DATA = join(homedir(), '.therascript')
const REAL_SETTINGS = join(
  homedir(),
  'Library',
  'Application Support',
  'therascript',
  'settings.json'
)
const REPO = 'adbstyle/therascripter'

export const dataDir = (home) => join(home, '.therascript')
export const dbPath = (home) => join(dataDir(home), 'data', 'therascript.db')
export const settingsPath = (home) =>
  join(home, 'Library', 'Application Support', 'therascript', 'settings.json')

export function resetHome(home) {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
}

/**
 * Modelle des Release-Macs als APFS-Klon ins Test-Home (sofort, kein
 * Speicherplatz). Die echten Modelle liest die App nie selbst — die Sandbox
 * verbietet ~/.therascript.
 */
export function cloneModels(home) {
  const source = join(REAL_DATA, 'models')
  if (!existsSync(source)) throw new Error(`Keine Modelle unter ${source} (Precondition 2)`)
  mkdirSync(dataDir(home), { recursive: true })
  execFileSync('cp', ['-c', '-R', source, join(dataDir(home), 'models')])
}

/**
 * Einstellungen für ein Home mit Modellen: aktive Modelle und installierte
 * Versionen vom Release-Mac, sonst der Zustand einer eingerichteten App ohne
 * offene Hinweise. Verlangt ein aktives Zusammenfassungsmodell (AK 4).
 */
export function writeModelSettings(home) {
  if (!existsSync(REAL_SETTINGS)) throw new Error(`Keine Einstellungen unter ${REAL_SETTINGS}`)
  const real = JSON.parse(readFileSync(REAL_SETTINGS, 'utf8'))
  if (!real.activeModels?.summarization) {
    throw new Error('Auf dem Release-Mac ist kein Zusammenfassungsmodell aktiv (Precondition 2)')
  }
  const settings = {
    activeModels: real.activeModels,
    installedModelVersions: real.installedModelVersions ?? {},
    modelsDownloaded: true,
    firstLaunchDone: true,
    backgroundReminderShown: true,
    pendingModelUpdates: null,
    microphoneWasGranted: false
  }
  mkdirSync(join(settingsPath(home), '..'), { recursive: true })
  writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2))
}

/**
 * sqlite3 im JSON-Modus, nur für SELECT. Ohne -readonly: Eine WAL-Datenbank
 * lässt sich nur lesend öffnen, wenn ihre -shm-Datei existiert (sonst
 * «unable to open database file»).
 */
export function query(home, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath(home), sql], {
    encoding: 'utf8'
  })
  return out.trim() ? JSON.parse(out) : []
}

/**
 * Verschiebt alle Zeitstempel so, dass die jüngste Sitzung «jetzt» angelegt
 * wurde — Abstände bleiben. Sonst löscht die App einen gecachten Seed nach 30
 * Tagen (Auto-Löschung) bzw. seine Quelldateien nach 24 h, und die Prüfung
 * hinge vom Tag ab (NFR 5).
 */
export function shiftTimestampsToNow(home) {
  const shift = (col) =>
    `${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${col}) + (julianday('now') - (SELECT max(julianday(created_at)) FROM sessions))) END`
  execFileSync('sqlite3', [
    dbPath(home),
    `UPDATE sessions SET ${shift('created_at')}, ${shift('updated_at')}, ${shift('review_at')};`
  ])
}

const semver = (tag) => tag.replace(/^v/, '').split('.').map(Number)
const isOlder = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

/** Jüngster veröffentlichter Release, der älter ist als `version`. */
export function previousReleaseTag(version) {
  const releases = JSON.parse(
    execFileSync(
      'gh',
      ['release', 'list', '-R', REPO, '--limit', '30', '--json', 'tagName,isDraft,isPrerelease'],
      { encoding: 'utf8' }
    )
  )
  const tags = releases
    .filter((r) => !r.isDraft && !r.isPrerelease && /^v\d+\.\d+\.\d+$/.test(r.tagName))
    .map((r) => r.tagName)
    .filter((tag) => isOlder(tag, `v${version}`))
    .sort((a, b) => (isOlder(a, b) ? 1 : -1))
  if (tags.length === 0) throw new Error(`Kein veröffentlichter Release älter als ${version}`)
  return tags[0]
}

/**
 * Lädt das DMG eines Releases (versionsloser Asset-Name, deshalb per Tag)
 * und entpackt die App in den Cache. Ein gh-Download trägt keine Quarantäne.
 */
export function previousApp(tag) {
  const appPath = join(BASE, 'prev', tag, 'Therascript.app')
  if (existsSync(appPath)) return appPath
  const download = mkdtempSync(join(BASE, 'download-'))
  const mount = join(download, 'mnt')
  try {
    execFileSync(
      'gh',
      ['release', 'download', tag, '-R', REPO, '--pattern', 'Therascript.dmg', '--dir', download],
      {
        stdio: 'inherit'
      }
    )
    mkdirSync(mount)
    execFileSync(
      'hdiutil',
      ['attach', join(download, 'Therascript.dmg'), '-nobrowse', '-readonly', '-mountpoint', mount],
      {
        stdio: 'ignore'
      }
    )
    try {
      mkdirSync(join(appPath, '..'), { recursive: true })
      execFileSync('ditto', [join(mount, 'Therascript.app'), appPath])
    } finally {
      execFileSync('hdiutil', ['detach', mount, '-quiet'])
    }
  } finally {
    rmSync(download, { recursive: true, force: true })
  }
  return appPath
}
