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

- `LlamaSummarizer` (`src/main/ml/LlamaSummarizer.ts`) — wrappt `llama-cli` als
  Subprozess, baut den Prompt (`summarization-prompt.ts`), parst den Output in
  `{ title, text }`. Path-traversal-Guard für die Modell-Datei.
- `SummarizationExecutor` (`src/main/ml/SummarizationExecutor.ts`) —
  TaskExecutor-Implementation. Skippt geräuschlos, wenn das Modell nicht installiert
  ist (`isModelInstalled` false) oder der anonymisierte Text leer/fehlend ist.
- `summary-handlers.ts` — IPC-Channels `summary:get`, `summary:updateTitle`,
  `summary:updateText` für die User-Bearbeitung.

Persistenz: Spalten `title` (existing, überschrieben), `summary`,
`summary_model_id`, `summarized_at` auf `sessions` (Migration 007).

## Prompt

Strukturierter Zwei-Block-Output (TITEL + ZUSAMMENFASSUNG) auf Deutsch, mit
expliziter Format-Specification. Der Parser toleriert Lower/Uppercase und
multi-line ZUSAMMENFASSUNG. Input wird auf 120k Zeichen gekürzt — für typische
Therapie-Sessions weit unter dem Limit.

Sampling: `--temp 0.3 --top-p 0.9 -n 260` — niedrige Temperatur für deterministische,
faktentreue Ausgabe. `--chat-template gemma`.

## Failure Modes

| Situation                              | Verhalten                                       |
| -------------------------------------- | ----------------------------------------------- |
| Modell nicht installiert               | Task erfolgreich, Summary bleibt NULL, Log-Info |
| Anonymisierter Text leer / kein File   | Task erfolgreich, Log-Info                      |
| llama-cli crashed / timeout            | Task failed, Session in Error-State             |
| Output unparsbar (TITEL/ZUSAMM. fehlt) | Task failed (siehe oben)                        |

UI behandelt fehlende Summary still: Kein Banner, kein CTA, kein Hinweis. h1
fällt auf "Sitzung ohne Titel" zurück (oder den ursprünglichen Auto-Titel),
SummaryPanel rendert `null`.

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
