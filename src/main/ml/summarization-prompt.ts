const MAX_INPUT_CHARS = 120_000

const INSTRUCTION = `Du bist ein professioneller Assistent für die Kurz-Beschreibung von Therapiesitzungen und medizinischen Dokumenten. Analysiere den folgenden Text und erzeuge zwei Ausgaben:

1. Einen prägnanten deutschen Titel (Nominalphrase, 3–8 Wörter, max. 80 Zeichen). Kein vollständiger Satz, keine Anführungszeichen, keine Einleitung.
2. Eine Zusammenfassung in genau zwei prägnanten deutschen Sätzen. Nenne die zentralen Themen und Schlüsselpunkte.

Formatiere die Antwort exakt so (zwei Zeilen, keine weiteren Inhalte):

TITEL: <dein Titel>
ZUSAMMENFASSUNG: <deine zwei Sätze>

Keine Einleitung, keine Aufzählungen, keine Meta-Kommentare, keine Markdown-Formatierung.`

export function buildSummarizationPrompt(text: string): string {
  const trimmed =
    text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) + '\n[... gekürzt ...]' : text
  return `${INSTRUCTION}\n\nText:\n---\n${trimmed}\n---`
}
