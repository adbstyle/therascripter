/**
 * Konstanten der Suche (Epic #192 — #209–#212). Eine Stelle für Main und
 * Renderer; Messwerte und Herkunft im Bauplan bzw. in
 * docs/product/features/search.md.
 */

/** Abschnittsbildung (Port von search-spike.py, Spike #208). */
export const SEARCH_TARGET_WORDS = 200
/** Längere Beiträge werden an Satzgrenzen (notfalls Wortgrenzen) geteilt. */
export const SEARCH_MAX_UNIT_WORDS = 120
/** Die letzte Unit eines Abschnitts wird bis zu dieser Länge im nächsten wiederholt. */
export const SEARCH_MAX_OVERLAP_WORDS = 60

/** Exakte Suche: Wörter ab dieser Länge sind Trigramm-Phrasen (#209 AK 3). */
export const SEARCH_MIN_TERM_LENGTH = 3
/** Länge einer Anfrage (Zeichen), auch die CHECK-Grenze der letzten Suchanfragen. */
export const SEARCH_MAX_QUERY_LENGTH = 200
/**
 * Anfragen ohne ein Wort ab 3 Zeichen findet der Trigramm-Index nicht; sie
 * laufen über einen Scan der Abschnitte, der nach so vielen Treffer-Abschnitten
 * aufhört (Entscheid des Orchestrators: «Scan mit Obergrenze»).
 */
export const SEARCH_SHORT_QUERY_MAX_CHUNKS = 500
/** … und durchsucht nur die neuesten so vielen Sitzungen (im Dossier: des Dossiers). */
export const SEARCH_SHORT_QUERY_MAX_SESSIONS = 500
/**
 * Exakte Suche: höchstens so viele Treffer-Abschnitte (die besten nach bm25)
 * werden gruppiert. Hält jede Abfrage bei 2'000 Sitzungen unter 100 ms; bei
 * einer Dossier-Suche gilt die Grenze innerhalb des Dossiers.
 */
export const SEARCH_MAX_CANDIDATE_CHUNKS = 2_000

/** Bis zu so viele Fundstellen pro Sitzung bzw. PDF-Dokument (Prototyp). */
export const SEARCH_MAX_HITS_PER_DOCUMENT = 3
/**
 * Höchstens so viele Sitzungen bzw. PDF-Dokumente pro Antwort. Der Schnitt
 * kommt NACH dem Dossier-Filter, damit eine Suche in einem Patientendossier
 * genau die Treffer der Suche über alle Inhalte in derselben Reihenfolge
 * liefert (#211 AK 3).
 */
export const SEARCH_MAX_DOCUMENT_RESULTS = 100
/** Höchstens so viele Patientendossiers unter den Treffern (#209 AK 23). */
export const SEARCH_MAX_DOSSIER_RESULTS = 20

/** Ausschnitt: Zeichen vor dem ersten Treffer bzw. Gesamtlänge (ungefähr). */
export const SEARCH_SNIPPET_LEAD_CHARS = 60
export const SEARCH_SNIPPET_MAX_CHARS = 220
/** Anker für «zur Fundstelle springen» ohne exaktes Wort: Anfang der Unit. */
export const SEARCH_ANCHOR_CHARS = 60

/**
 * Schwelle «ausreichend passend» für Treffer nach Bedeutung (#209 AK 6),
 * kalibriert im Abnahmetest (PR S6, Tabelle in docs/product/features/search.md):
 * auf dem Referenz-Set zeigen bei 0.71 noch 75 % der Anfragen mit Treffern
 * einen relevanten Treffer (Produktiv-Rangfolge, nach Bedeutung allein 60 %),
 * und 8 von 10 Anfragen ohne Treffer zeigen nichts (bei 0.70: 77 % / 63 %,
 * 4 von 10); der Recall der Abschnitte mit Note 2 sinkt dabei von 44 auf
 * 36 % (nach Bedeutung) bzw. von 44 auf 40 % (sichtbare Reihenfolge). Kleines Set (148 Abschnitte, 10 Anfragen ohne Treffer) — die
 * endgültige Wahl trifft der Product Owner.
 */
export const SEARCH_SEMANTIC_THRESHOLD = 0.71

/**
 * Felder, die an der Suche nach Bedeutung teilnehmen (bekommen Vektoren und
 * sind semantische Kandidaten). Titel nicht: kurze Titel («Sitzung 1»,
 * «Aufnahme 12.11.2026 16:30») erreichen hohe Kosinuswerte und verdrängten im
 * Abnahmetest Text-Treffer (nDCG@10 0.461 statt 0.568); erfundene Begriffe
 * lieferten in der Sichtprüfung nur Titel fremder Sitzungen. Titel werden
 * weiterhin EXAKT gefunden (#209 AK 5). Zusammenfassungen bleiben drin.
 */
export const SEARCH_SEMANTIC_FIELDS = ['summary', 'body'] as const

/**
 * Vektorphase nach einer Bearbeitung (#212 AK 2): Eine neue Textgeneration
 * hebt die Wartezeit eines früheren Fehlers auf (sofortiger Neuversuch), die
 * Zahl der Fehler bleibt aber stehen — der nächste Fehler wartet länger;
 * zurück auf 0 erst nach einer ERFOLGREICHEN Vektorgeneration. Ab so vielen
 * Fehlern in Folge löst eine Bearbeitung keinen sofortigen Neuversuch mehr
 * aus (eine Sitzung, die den Suchprozess immer abstürzen lässt, startet ihn
 * sonst bei jeder Bearbeitungspause neu).
 */
export const SEARCH_VECTOR_EDIT_RETRY_MAX_FAILURES = 3

/** Textphase der Aufbereitung (#212): ruhiges Fenster und Takt. */
export const SEARCH_QUIET_WINDOW_MS = 10_000
export const SEARCH_TICK_MS = 5_000
/** Höchstens so viele Sitzungen pro Scheibe der Textphase. */
export const SEARCH_TEXT_PHASE_BATCH = 25
/**
 * Zeitscheibe der Hintergrundschleife (Löschen, Aufräumen, Textphase). Die
 * Restzeit wird vor jedem Arbeitsschritt geprüft; ein einzelner sehr grosser
 * Schritt darf sie überschreiten.
 */
export const SEARCH_SLICE_MS = 40
/**
 * Budget für das Löschen von Abschnitten in einer Scheibe (Löschen eines
 * Dokuments, Aufräumen alter Generationen). Kleiner, weil das Commit danach
 * mit FTS5 'secure-delete' noch einmal ~25–50 ms kostet (gemessen in einer
 * DB mit 2'000 Sitzungen); so bleibt eine Scheibe unter ~100 ms.
 */
export const SEARCH_DELETE_SLICE_MS = 15
/** Echte Pause zwischen zwei Scheiben — der Main-Prozess bleibt reaktionsfähig. */
export const SEARCH_SLICE_PAUSE_MS = 30

/** Letzte Suchanfragen (#209 AK 27). */
export const SEARCH_RECENT_LIMIT = 5

/**
 * Suchprozess (PR S4, Bauplan 5b). Zeitlimits [A, auf einem 8-GB-Mac
 * nachmessen]: Start bis zur Startzeile, eine Suchanfrage, ein Batch der
 * Aufbereitung.
 */
export const SEARCH_WORKER_START_TIMEOUT_MS = 60_000
export const SEARCH_WORKER_QUERY_TIMEOUT_MS = 10_000
export const SEARCH_WORKER_BATCH_TIMEOUT_MS = 60_000
/** Arbeitsspeicher freigeben nach so langer Zeit ohne Suche bzw. Batch (#209 AK 17). */
export const SEARCH_WORKER_IDLE_MS = 5 * 60_000
/**
 * Neustart des Suchprozesses zwischen zwei Batches, sobald sein
 * phys_footprint diese Grenze überschreitet: auf MPS wächst er pro
 * Forward-Pass um ~50–130 KiB ausserhalb des torch-Allokators (Review S1).
 * Bereit nach dem Laden ~1.6 GiB, Aufbereiten bis ~2.1 GiB — die Grenze
 * hält den Prozess unter den 3.5 GiB von #209 AK 15.
 */
export const SEARCH_WORKER_RESTART_FOOTPRINT_BYTES = 2.5 * 1024 ** 3
/**
 * Nach einem Absturz bzw. gescheiterten Start: so lange kein neuer Versuch —
 * und nur so lange meldet die Suche den Fehler; danach versucht die nächste
 * Anfrage einen Neustart.
 */
export const SEARCH_WORKER_FAILURE_COOLDOWN_MS = 30_000
/**
 * Nach so vielen gescheiterten Starts in Folge startet die Aufbereitung den
 * Suchprozess nicht mehr (keine Startschleife mit Speicherspitze), bis das
 * Modell neu bereitgestellt wird, eine USER-Suche ihn erfolgreich startet
 * oder die App neu startet.
 */
export const SEARCH_WORKER_MAX_START_FAILURES = 3

/** Vektorphase: Abschnitte pro Anfrage an den Suchdienst und pro Commit (Review S1). */
export const SEARCH_VECTOR_BATCH = 2
/** Backoff einer Sitzung nach einem Fehler der Vektorphase: 1 min, 5 min, 30 min, 6 h. */
export const SEARCH_VECTOR_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const
/**
 * Kosinus über alle Abschnitte im Main-Prozess: höchstens so lange am Stück
 * rechnen, dann den Event-Loop freigeben.
 */
export const SEARCH_COSINE_SLICE_MS = 20
/** Beim Beenden der App: ausstehendes gestaffeltes Löschen höchstens so lange fortsetzen. */
export const SEARCH_QUIT_PURGE_BUDGET_MS = 2_000
