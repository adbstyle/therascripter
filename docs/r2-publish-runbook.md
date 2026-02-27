# Operator Runbook: ML-Modelle auf R2 veröffentlichen

Dieser Runbook beschreibt, wie neue oder aktualisierte ML-Modelle auf Cloudflare R2 veröffentlicht werden.

> **Hinweis:** Der Python-Sidecar (`ml_sidecar/`) wird **nicht** über R2 ausgeliefert — er ist via `extraResources` direkt im DMG gebundelt und wird mit jeder App-Version neu ausgeliefert.

## Voraussetzungen

- macOS mit Apple Silicon (ARM64)
- AWS CLI: `brew install awscli`
- `.env`-Datei im Projektroot mit R2-Credentials (nie committen):
  ```
  CLOUDFLARE_ACCOUNT_ID=...
  R2_ACCESS_KEY_ID=...
  R2_SECRET_ACCESS_KEY=...
  ```
  R2 API-Token erstellen: Cloudflare Dashboard → R2 → Manage R2 API Tokens
- Python venv aufgesetzt: `python_sidecar/venv/` (einmalig via `scripts/setup-pyannote.sh --model` + `scripts/setup-ner.sh --model`)
- Alle Modelle lokal vorhanden: `~/.therascript/models/asr/`, `diarization/`, `ner/`

## Vollständige Pipeline (empfohlen)

```bash
npm run sidecar:deploy
```

Dies führt in einem Schritt aus:
1. `sidecar:build` — PyInstaller bundelt Python-Sidecar → `python_sidecar/dist/ml_sidecar/`
2. `sidecar:package` — Packt ML-Modelle → `r2-upload/`
3. `sidecar:upload` — Generiert `manifest.json` und lädt Modelle auf R2 hoch

## Einzelschritte (bei Bedarf)

### Schritt 1: Sidecar bauen

```bash
npm run sidecar:build
```

Ergebnis: `python_sidecar/dist/ml_sidecar/` (PyInstaller-Bundle, kein Python-venv nötig)

### Schritt 2: Archivieren

```bash
npm run sidecar:package
```

Ergebnis in `r2-upload/`:

| Datei | Inhalt |
|-------|--------|
| `whisper-ggml-large-v3-turbo-q5_0.bin` | Whisper-Modell (~1.7 GB) |
| `pyannote-models.tar.gz` | Pyannote-Diarisierungsmodelle |
| `flair-ner-german-large.tar.gz` | flair NER-Modell (~1.1 GB) |

Das Script gibt SHA-256-Hashes und Dateigrößen aus.

### Schritt 3: Manifest generieren + hochladen

```bash
npm run sidecar:upload
```

Das Script:
- Berechnet SHA-256 und Größe für jede Datei in `r2-upload/`
- Schreibt `manifest.json` ins Projektroot
- Lädt `manifest.json` auf R2 hoch
- Lädt die Modelldateien via AWS CLI (Multipart-Upload, kein 300-MB-Limit) hoch

Dry-Run (kein Upload):
```bash
scripts/publish-manifest.sh --dry-run
```

## Nach dem Upload

### TypeScript-Check
```bash
npm run typecheck
```

### manifest.json committen
```bash
git add manifest.json
git commit -m "chore: update model manifest $(date +%Y-%m-%d)"
```

### Verifikation

CDN-URL: `https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/`

```bash
# manifest.json prüfen
curl https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json | jq .

# Datei im Bucket prüfen
aws s3 ls s3://therascript/ \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

## Rollback

R2 versioniert Dateien nicht automatisch. Rollback = altes Modell neu packen und hochladen:

1. Altes Modell lokal wiederherstellen (z.B. aus Time Machine)
2. `npm run sidecar:package` mit dem alten Modell-Stand
3. `npm run sidecar:upload`
4. `git add manifest.json && git commit -m "chore: rollback model manifest"`

## Troubleshooting

| Problem | Lösung |
|---------|--------|
| `Sidecar-Build nicht gefunden` | `npm run sidecar:build` zuerst ausführen |
| `R2-Credentials fehlen` | `.env`-Datei prüfen, Variablen vorhanden? |
| `AWS CLI nicht gefunden` | `brew install awscli` |
| `Modelldatei nicht gefunden` | `~/.therascript/models/` prüfen, Modelle heruntergeladen? |
| SHA-256-Fehler im Client | `manifest.json` SHA-256 stimmt nicht mit Datei überein — nochmals packen + hochladen |

## Wie der Client Updates erkennt

`ModelUpdateService.ts` prüft beim App-Start `manifest.json` auf R2. Ein Update wird erkannt wenn:
- Die `sha256`-Checksumme der Manifest-Version ≠ der lokal gespeicherten Checksumme (`installedModelVersions` in electron-store)

Neu installierte Apps ohne gespeicherte Versions-Info werden via `migrateInstalledVersions()` als `pre-update` markiert, was beim nächsten Manifest-Check ein Update auslöst.
