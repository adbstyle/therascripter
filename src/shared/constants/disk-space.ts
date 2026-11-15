/**
 * Mindestens freier Speicherplatz für die Ersteinrichtung (Download plus
 * Entpacken). Binär gerechnet (5 GiB = 5.37 GB) — die Schwelle ist seit
 * jeher so; angezeigt wird sie wie alle Grössen dezimal (formatBytes:
 * «5.4 GB»), damit «Verfügbar» und «Benötigt» dieselbe Einheit haben.
 */
export const MINIMUM_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024
