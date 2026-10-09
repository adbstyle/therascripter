import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'

/**
 * Schwellen relativ zur Schriftgrösse des vorigen Items. Vorwärtslücke und
 * Grundlinien-Versatz sind die Werte, ab denen pdfjs innerhalb EINES Laufs
 * selbst ein Leerzeichen setzt bzw. flusht (`SPACE_IN_FLOW_MIN_FACTOR` /
 * `VERTICAL_SHIFT_RATIO` im pdf.worker) — darin urteilen wir über
 * Item-Grenzen hinweg wie pdfjs. Gemessen an Glyphe-pro-Item-PDFs liegen
 * echte Wort-innere Lücken unter 0.1 em.
 *
 * Rückwärts weichen wir bewusst ab: pdfjs flusht schon ab -0.2 em
 * (`NEGATIVE_SPACE_FACTOR`). Die in Glyphe-pro-Item-PDFs gemessenen
 * Wort-inneren Überlappungen (Kerning) liegen zwar alle oberhalb -0.2 em, aber
 * nahe dran. -0.5 em lässt Abstand dazu und zu separat gesetzten Akzenten
 * über dem Grundbuchstaben; Tabellen-Rücksprünge liegen bei vielen em.
 */
const GAP_FORWARD = 0.102
const GAP_BACKWARD = -0.5
const BASELINE_SHIFT = 0.25

/**
 * Setzt die Text-Items einer Seite zu Fliesstext zusammen.
 *
 * WARUM NICHT `join(' ')`: pdfjs liefert Leerzeichen bereits als eigene
 * Items bzw. im `str` (aus Lücken zwischen Glyphen abgeleitet) und markiert
 * Zeilenenden mit `hasEOL`. Ein Item ist also KEIN Wort, sondern ein Lauf
 * gleich gesetzter Glyphen — manche Generatoren (gespiegelter Textraum mit
 * negativer Schriftgrösse + TJ-Kerning, z. B. Mietwagen-Rechnungen) erzeugen
 * ein Item pro Glyphe. `join(' ')` machte daraus „H a n s", und flair taggte
 * die Einzelbuchstaben massenhaft als PERSON. Der pdfjs-Viewer selbst
 * verkettet deshalb mit `''` und bricht nur an `hasEOL` um.
 *
 * WARUM NICHT NUR `join('')`: pdfjs flusht bei Rücksprüngen auf derselben
 * Grundlinie (Tabellenzellen), bei Grundlinien-Versatz (Hoch-/Tiefstellung)
 * und an Content-Stream-Grenzen OHNE Trenner. Dort würden Wörter verkleben —
 * „Müller¹" als „Müller1" erkennt weder flair noch die Sperrliste. Deshalb
 * entscheidet an solchen Grenzen die Geometrie.
 */
export function joinTextItems(items: ReadonlyArray<TextItem | TextMarkedContent>): string {
  let out = ''
  let prev: TextItem | undefined
  for (const item of items) {
    if (!('str' in item)) continue
    if (item.str) {
      if (prev && !/\s$/.test(out) && !/^\s/.test(item.str) && isDiscontinuous(prev, item)) {
        out += ' '
      }
      out += item.str
      prev = item
    }
    if (item.hasEOL) out += ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Liegt `next` NICHT direkt im Schreibfluss hinter `prev`? */
function isDiscontinuous(prev: TextItem, next: TextItem): boolean {
  const [a, b, c, d, x, y] = prev.transform
  const advanceScale = Math.hypot(a, b)
  const fontSize = Math.hypot(c, d)
  if (!advanceScale || !fontSize) return true

  // In die Schreibrichtung von `prev` projizieren — deckt gedrehten Text ab.
  const ux = a / advanceScale
  const uy = b / advanceScale
  const dx = next.transform[4] - x
  const dy = next.transform[5] - y
  const gap = dx * ux + dy * uy - prev.width
  const shift = dy * ux - dx * uy

  return (
    Math.abs(shift) > BASELINE_SHIFT * fontSize ||
    gap > GAP_FORWARD * fontSize ||
    gap < GAP_BACKWARD * fontSize
  )
}
