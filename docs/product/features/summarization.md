# Lokale Zusammenfassung (Gemma 4 E2B)

## Zweck

Erzeugt am Ende der Pipeline für jede Sitzung (Audio oder PDF) lokal:

- Einen prägnanten **Titel** (Nominalphrase, 3–8 Wörter) — überschreibt das bisher
  generische `Sitzung 14.02.2026 14:30`-Pattern.
- Eine **2-Satz-Zusammenfassung** der zentralen Themen.

Beide werden im Review-Editor als h1 + Panel angezeigt und sind inline editierbar.

## Modell

- **Default**: `google/gemma-4-E2B-it-qat-q4_0-gguf` (Googles offizielles QAT-GGUF,
  3.35 GB), Metal-beschleunigt via `llama.cpp`. Lizenz Apache 2.0 — der Lizenztext
  steht in der App unter Über → Acknowledgments (zusammen mit allen anderen Modellen und Komponenten, Quelle: `src/renderer/src/constants/acknowledgments.ts`).
- **Optional** — nicht Teil des First-Launch-Downloads. Installation über
  Settings → Modelle → "Zusammenfassung (optional)".
- **Abgelöst: Gemma 3 4B Instruct** (Gemma Terms of Use, Weitergabe nur mit
  Lizenzhinweis und weitergereichter Prohibited Use Policy). Beim ersten Start nach
  dem Update löscht `retireObsoleteModels()` die Datei, leert den Slot und meldet ein
  `model-retired`-Event (Banner in Settings → Modelle); der Nachfolger wird nicht
  ungefragt geladen. Messwerte des Wechsels: Issue #57.
- **Gemma 4 E4B** (5.15 GB) wäre qualitativ besser, braucht aber ~5.2 GB RAM während
  der Inferenz — auf 8-GB-Macs am Metal-Limit, deshalb nicht im Katalog.

## Architektur

Summarization läuft als **letzter Schritt der TaskQueue-Pipeline**:

```
Audio: transcription → diarization → alignment → anonymization → summarization
PDF:   extraction → ocr → anonymization → summarization
```

Komponenten:

- `summarization-schema.ts` — **Single source of truth für die Output-Form**.
  Definiert die Längengrenzen einmal als Konstanten; daraus entstehen das
  Zod-Schema (`SummarizationOutputSchema`) und die GBNF-Grammatik
  (`SUMMARIZATION_GBNF`), die an llama-cli durchgereicht wird.
- `LlamaSummarizer` (`src/main/ml/LlamaSummarizer.ts`) — wrappt `llama-cli` als
  Subprozess. Übergibt die Grammatik via `--grammar`-Argument; die
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
es durch llama.cpp's `--grammar`-Flag zur Format-Treue *gezwungen*: Bei jedem
Sampling-Schritt werden nur Token zugelassen, die zu einem `{title, summary}`-Objekt
führen können (Titel 3–80 Zeichen, Zusammenfassung 20–1000 Zeichen, keine weiteren
Felder).

Die Grammatik ist exakt das, was llama.cpp's eigener JSON-Schema-Konverter für dieses
Schema erzeugt. `--json-schema` selbst ist tabu: mit Gemma 4 scheitert der
Sampler-Init des gebundelten llama-cli (b9200) und der Prozess exitet trotzdem 0 —
in der App ein stiller Skip jeder Zusammenfassung (Issue #57, upstream
ggml-org/llama.cpp#22396).

Konsequenz: Es ist physisch unmöglich, dass das Modell Prosa, Markdown, freien
Text oder ein anderes Format ausgibt. Der Prompt beschreibt nur noch die
*Semantik* der zwei Felder, nicht ihre Struktur.

Sampling: `--temp 0.3 --top-p 0.9 -n 400 -st -rea off -ngl 999` — niedrige Temperatur
für deterministische faktentreue Ausgabe, single-turn-Mode mit Jinja-Chat-Template
aus dem GGUF, kein Reasoning-Block (Gemma 4 ist ein Reasoning-Modell), Metal
full-GPU-offload.

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

- Inference: ~3.4–3.5 GB RSS (gemessen auf M5 Pro, kurze Texte bis 24k Zeichen).
  Die Gewichte sind per mmap eingeblendet und zählen deshalb nicht in
  `phys_footprint` (~0.3 GB) — bei llama.cpp ist RSS der richtige Massstab. Läuft
  sequenziell nach Anonymisierung — kein RAM-Konflikt.
- Laufzeit: 3–8 s pro Sitzung auf dem M5 Pro (~75 Token/s Generierung).
- Disk: 3.35 GB für das Modell + ~5 MB für `llama-cli` + dylibs.

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
