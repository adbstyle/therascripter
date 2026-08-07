// Muss mit LLAMA_CONTEXT_SIZE (-c 8192) in LlamaSummarizer zusammenpassen:
// 24k Zeichen ≈ 6k deutsche Tokens + Instruction (~250 Tokens) + 400 Output-
// Tokens < 8192. Der frühere 120k-Wert lief gegen llama-clis 4096-Default —
// der Großteil der Prompt-Eval-Zeit war bezahlt, aber ohne Wirkung auf die
// Summary (stille Truncation/Context-Shift).
const MAX_INPUT_CHARS = 24_000

/**
 * The output format is enforced by `--json-schema` on the llama-cli side
 * (see SUMMARIZATION_JSON_SCHEMA in summarization-schema.ts), so the prompt
 * doesn't need TITEL/ZUSAMMENFASSUNG headers, line-format diktats, or any
 * "answer exactly so" instructions — the grammar engine constrains the
 * model's tokens directly. We just describe what the two fields should
 * contain semantically and let the schema do the structural work.
 */
const INSTRUCTION = `Du bist ein professioneller Assistent für die Kurz-Beschreibung von Therapiesitzungen und medizinischen Dokumenten. Lies den folgenden Text und erzeuge ein JSON-Objekt mit zwei Feldern:

- title: Ein prägnanter deutscher Titel (Nominalphrase, 3–8 Wörter, max. 80 Zeichen). Kein vollständiger Satz, keine Anführungszeichen, keine Einleitung.
- summary: Eine Zusammenfassung in genau zwei prägnanten deutschen Sätzen mit den zentralen Themen und Schlüsselpunkten.

Antworte ausschließlich mit dem JSON-Objekt — keine Einleitung, keine Erklärung, keine Markdown-Code-Fences.`

export function buildSummarizationPrompt(text: string): string {
  const trimmed =
    text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) + '\n[... gekürzt ...]' : text
  return `${INSTRUCTION}\n\nText:\n---\n${trimmed}\n---`
}
