# Lokale Zusammenfassung (Gemma 3 4B Instruct)

## Zweck

Erzeugt am Ende der Pipeline für jede Sitzung (Audio oder PDF) lokal:

- Einen prägnanten **Titel** (Nominalphrase, 3–8 Wörter) — überschreibt das bisher
  generische `Sitzung 14.02.2026 14:30`-Pattern.
- Eine **2-Satz-Zusammenfassung** der zentralen Themen.

Beide werden im Review-Editor als h1 + Panel angezeigt und sind inline editierbar.

## Modell

- **Default**: `bartowski/gemma-3-4b-it-GGUF` Q4_K_M (~2.5 GB), Metal-beschleunigt
  via `llama.cpp`.
- **Optional** — nicht Teil des First-Launch-Downloads. Installation über
  Settings → Modelle → "Zusammenfassung (optional)".
- Geplante Migration auf Gemma 4 E4B Instruct, sobald upstream eine GGUF-Konvertierung
  verfügbar ist (siehe CLAUDE.md "Gemma 4 E4B GGUF source").

## Architektur

Summarization läuft als **letzter Schritt der TaskQueue-Pipeline**:

```
Audio: transcription → diarization → alignment → anonymization → summarization
PDF:   extraction → ocr → anonymization → summarization
```

Komponenten:

- `summarization-schema.ts` — **Single source of truth für die Output-Form**.
  Definiert das Zod-Schema (`SummarizationOutputSchema`) sowie die
  korrespondierende JSON-Schema-Repräsentation (`SUMMARIZATION_JSON_SCHEMA`),
  die an llama-cli durchgereicht wird. Beide werden via Unit-Test in Sync
  gehalten.
- `LlamaSummarizer` (`src/main/ml/LlamaSummarizer.ts`) — wrappt `llama-cli` als
  Subprozess. Übergibt das JSON-Schema via `--json-schema`-Argument; die
  llama.cpp Grammar-Engine constrained Token-Sampling, sodass das Modell nur
  Token erzeugen kann, die zu validem Schema-Output führen. Parser
  (`extractFirstJSONObject` + `JSON.parse` + Zod-Validierung) ist robust gegen
  jegliches stdout-Rauschen (Loading-Spinner, Banner, Perf-Stats). Path-
  traversal-Guard für die Modell-Datei.
- `SummarizationExecutor` (`src/main/ml/SummarizationExecutor.ts`) —
  TaskExecutor-Implementation. Wrappt `summarize()` in try/catch: ANY Fehler
  (Subprocess-Crash, Abort, JSON-Extraction-Failure, Schema-Validation-Failure)
  loggt + returnt clean. Session erreicht IMMER `review`, `sessions.summary`
  bleibt im Fehlerfall NULL. Kein Error-State-Poisoning der ganzen Sitzung.
- `summary-handlers.ts` — IPC-Channels `summary:get`, `summary:updateTitle`,
  `summary:updateText` für die User-Bearbeitung.

Persistenz: Spalten `title` (existing, überschrieben), `summary`,
`summary_model_id`, `summarized_at` auf `sessions` (Migration 007).

## Output-Garantien via Grammar-Constrained Sampling

Anstatt das Modell durch Prompt-Anweisungen zur Format-Treue zu *bitten*, wird
es durch llama.cpp's `--json-schema`-Flag zur Format-Treue *gezwungen*: Bei
jedem Sampling-Schritt werden nur Token zugelassen, die zu einem JSON-Dokument
führen können das zu folgendem Schema passt:

```json
{
  "type": "object",
  "properties": {
    "title":   { "type": "string", "minLength": 3,  "maxLength": 80   },
    "summary": { "type": "string", "minLength": 20, "maxLength": 1000 }
  },
  "required": ["title", "summary"],
  "additionalProperties": false
}
```

Konsequenz: Es ist physisch unmöglich, dass das Modell Prosa, Markdown, freien
Text oder ein anderes Format ausgibt. Der Prompt beschreibt nur noch die
*Semantik* der zwei Felder, nicht ihre Struktur.

Sampling: `--temp 0.3 --top-p 0.9 -n 400 -st -ngl 999` — niedrige Temperatur für
deterministische faktentreue Ausgabe, single-turn-Mode mit Jinja-Chat-Template
aus dem GGUF, Metal full-GPU-offload.

## Failure Modes

| Situation                                            | Verhalten                                         |
| ---------------------------------------------------- | ------------------------------------------------- |
| Modell nicht installiert                             | Task erfolgreich, Summary bleibt NULL, Log-Info   |
| Anonymisierter Text leer / kein File                 | Task erfolgreich, Log-Info                        |
| llama-cli crashed / timeout                          | Executor logs + skip → Session erreicht `review`  |
| JSON nicht extrahierbar / Schema-Validation-Fehler   | Executor logs + skip → Session erreicht `review`  |
| Abort-Signal während Inferenz                        | Executor logs + skip → Session erreicht `review`  |

Alle Fehlerpfade enden nicht in `error`-State — der anonymisierte Transkript
ist intakt und der User soll den Review-Editor öffnen können. UI behandelt
fehlende Summary still: Kein Banner, kein CTA, kein Hinweis. h1 fällt auf
formatiertes Datum zurück (oder den ursprünglichen Auto-Titel), SummaryPanel
rendert `null`.

Migration 008 (`008-reset-summarization-parse-errors.sql`) repariert Sessions,
die durch eine frühere Version dieses Codes (regex-basierter TITEL/
ZUSAMMENFASSUNG-Parser, der am llama-cli Spinner-ASCII gescheitert ist) in
`error`-State steckengeblieben sind: targeted reset auf `review` mit `error_message=NULL` für genau die betroffenen Rows.

## RAM + Disk Cost

- Inference: ~3 GB Working Set (4B Q4_K_M + KV-Cache für ~3k Tokens). Läuft
  sequenziell nach Anonymisierung — kein RAM-Konflikt.
- Disk: 2.5 GB für das Modell + ~5 MB für `llama-cli` + dylibs.

## Privacy

- Ausschließlich lokal. Keine Netzwerk-Calls, kein Telemetrie.
- Anonymisierter Text wird verarbeitet — Roh-Transkripte erreichen das Modell
  nie. Platzhalter wie `[PERSON 1]` werden im Prompt verbatim erhalten.

## UI-Einstiege

- Settings → Modelle → "Zusammenfassung (optional)" — Download/Aktivierung.
- Review-Editor → h1 (Titel) + Zusammenfassung-Panel — automatisch sichtbar
  wenn Summary persistiert.
- Session-Liste → Titel als primäres Label (Fallback auf Datum bei leerem Titel).

## Bekannte Einschränkungen

- Keine Regenerate-Schaltfläche. Wer Re-Run will, muss aktuell die Session
  retrying-en (Settings → Sitzung erneut verarbeiten). Kann später als IPC
  `summary:regenerate` nachgezogen werden.
- Kein In-Progress-State im UI — Sitzung erscheint erst im Review nachdem die
  ganze Pipeline (inklusive LLM) durch ist. Während der LLM-Stage läuft die
  Status-Anzeige weiter auf "Anonymisierung" (kein eigener `summarizing`
  SessionStatus).
