import type Database from 'better-sqlite3'

// Datenbank-Wartung ausserhalb der Migrations-Transaktionen (Issue #202).

/** Name des einmaligen Wartungsschritts in app_maintenance (Migration 018). */
export const SECURE_DELETE_VACUUM = 'secure-delete-vacuum'

/**
 * PRAGMA wal_checkpoint(TRUNCATE): schreibt den WAL in die Datenbankdatei und
 * kürzt ihn auf null Bytes. Gibt false zurück, wenn der Checkpoint blockiert
 * war (busy ≠ 0) und deshalb nicht vollständig lief.
 */
export function walCheckpointTruncate(db: Database.Database): boolean {
  const result = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
  return (result[0]?.busy ?? 0) === 0
}

/**
 * Läuft bei jedem Öffnen der Datenbank, nach den Migrationen.
 *
 * 1. Einmalig nach dem Update auf #202: VACUUM. secure_delete überschreibt nur
 *    künftig freigegebene Inhalte; bei Bestandsnutzer:innen liegen ältere
 *    Fassungen (z. B. entity_map mit Klarnamen, früher gelöschte Sitzungen) noch
 *    in freien Seiten und Freiblöcken. VACUUM baut die Datei neu auf. Es darf
 *    nicht in einer Transaktion laufen und steht deshalb nicht im
 *    Migrations-Runner; Migration 018 legt den Schritt als offen an, erst nach
 *    erfolgreichem VACUUM wird er als erledigt vermerkt — bricht der Start
 *    mittendrin ab, läuft er beim nächsten Start erneut (VACUUM ist atomar).
 * 2. Immer: WAL-Checkpoint. Holt einen blockierten Checkpoint nach dem Löschen
 *    nach und schliesst die Lücke «Absturz zwischen Commit und Checkpoint».
 */
export function runStartupMaintenance(db: Database.Database): void {
  // Beide Schritte sind nicht startkritisch: ein Fehler (z. B. Platte voll
  // beim VACUUM) wird geloggt, der Schritt bleibt offen und läuft beim
  // nächsten Start erneut — die App startet trotzdem.
  try {
    const pending = db
      .prepare('SELECT 1 FROM app_maintenance WHERE task = ? AND done_at IS NULL')
      .get(SECURE_DELETE_VACUUM)
    if (pending) {
      db.exec('VACUUM')
      db.prepare('UPDATE app_maintenance SET done_at = ? WHERE task = ?').run(
        new Date().toISOString(),
        SECURE_DELETE_VACUUM
      )
      console.log('[DB] Einmaliges VACUUM nach Aktivierung von secure_delete ausgeführt')
    }
  } catch (error) {
    console.error(
      '[DB] Einmaliges VACUUM fehlgeschlagen — wird beim nächsten Start wiederholt:',
      error
    )
  }

  try {
    if (!walCheckpointTruncate(db)) {
      console.error(
        '[DB] WAL-Checkpoint beim Start blockiert — wird beim nächsten Löschen nachgeholt'
      )
    }
  } catch (error) {
    console.error('[DB] WAL-Checkpoint beim Start fehlgeschlagen:', error)
  }
}
