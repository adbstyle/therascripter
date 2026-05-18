# Plan: ggml-ABI-Konflikt zwischen whisper.cpp und llama.cpp auflösen

## Problem (verifiziert via otool)

`whisper-cli` und `llama-cli` teilen sich `resources/lib/` und linken beide gegen
`@rpath/libggml*.dylib`. Die beiden Tools werden von Homebrew aber gegen
**inkompatible ggml-Generationen** kompiliert:

| Binary | linkt gegen ggml | tatsächlich in resources/lib/ |
|---|---|---|
| `whisper-cli` (Feb 14)  | current **0.9.5**  | `libggml.0.dylib` **0.10.0** ⚠ |
| `llama-cli`  (Apr 26)   | current **0.10.0** | gleiches File |

`scripts/setup-llama.sh` hat am 26.04. die libggml-Dylibs aus der `ggml`-Formula
(0.10.0) nach `resources/lib/` kopiert und damit die whisper-kompatible
Generation (0.9.5) überschrieben. Resultat: `whisper-cli` crasht beim
Modell-Init in `make_buft_list` (ABI-Mismatch, Symbol-Signatur hat sich geändert).

Setup-Reihenfolge ist **strukturell fragil** — jedes erneute Ausführen von
`setup-whisper.sh` oder `setup-llama.sh` kippt das Gleichgewicht. Ein
`./scripts/setup-whisper.sh` repariert whisper, killt aber latent llama.

## Verschärfungen gegenüber initialem Befund

1. **Production-Distribution betroffen.** `electron-builder` packt
   `resources/lib/` in die DMG. Aktuell würde whisper auf jedem Endnutzer-Mac
   crashen. Release-Blocker.
2. **`llama-cli` hat parallel ein eigenes Bundling-Bug.** `otool -L` zeigt
   absolute Pfade `/opt/homebrew/opt/ggml/lib/libggml*.dylib` statt `@rpath/...`.
   Auf einem Endnutzer-Mac ohne Homebrew an exakt diesem Pfad lädt llama nicht.
3. **„Einheitliches ggml-Upgrade" ist nicht realistisch.** `whisper-cpp 1.8.3`
   linkt ggml 0.9.5, `llama.cpp 8940` linkt ggml 0.10.0. Ohne Source-Build
   einer der beiden Toolchains zur Deckung zu bringen → Library-Trennung ist
   die einzige robuste Option.

## Entscheidung: per-Tool Self-Contained Bundles

```
resources/
├── whisper/
│   ├── bin/whisper-cli                 (Feb-Generation)
│   └── lib/libwhisper.1.dylib + libggml*.dylib   (ggml 0.9.5)
├── llama/
│   ├── bin/llama-cli                   (Apr-Generation)
│   └── lib/libllama*.dylib + libmtmd*.dylib + libggml*.dylib   (ggml 0.10.0)
├── bin/
│   ├── ffmpeg                          (no shared deps)
│   └── vision-ocr                      (no shared deps)
└── (resources/lib/ wird gelöscht)
```

Beide Binaries haben bereits `LC_RPATH = @loader_path/../lib`. Durch die neue
Verzeichnisstruktur resolved dieser rpath **automatisch** in die jeweils
tool-spezifische `lib/`-Schwester. **Keine `install_name_tool`-Surgery am
whisper-Binary nötig.**

### Warum nicht Alternativen

| Option | Bewertung |
|---|---|
| **A:** gemeinsames `resources/lib/` + per-Tool rpath via `install_name_tool` | funktioniert, aber Surgery + Re-Codesign + fragil bei Brew-Updates |
| **B:** `DYLD_LIBRARY_PATH` beim Spawnen | Konflikt mit Hardened Runtime, env-basiert statt strukturell |
| **C:** per-Tool bin+lib Bundles **(gewählt)** | nutzt bestehenden rpath unverändert, idempotent, symmetrisch |
| **D:** einheitliche ggml-Version | unrealistisch (s. Punkt 3 oben) |

Caveat: `llama-cli` braucht *einmalig* `install_name_tool -change` (absolute
Pfade → @rpath). Das ist ein Setup-Step in `setup-llama.sh`, keine laufende
Wartung.

## Implementation

### Phase 1 — Setup-Skripte

1. **`scripts/setup-whisper.sh`**
   - `BIN_DIR="$PROJECT_ROOT/resources/whisper/bin"`
   - `LIB_DIR="$PROJECT_ROOT/resources/whisper/lib"`
   - Migrations-Cleanup am Anfang: `rm -rf resources/bin/whisper-cli resources/lib/libwhisper.* resources/lib/libggml*` (nur falls noch alte Mischung vorhanden).
   - Sonst keine Logik-Änderung.

2. **`scripts/setup-llama.sh`**
   - `BIN_DIR="$REPO_ROOT/resources/llama/bin"`
   - `LIB_DIR="$REPO_ROOT/resources/llama/lib"`
   - **Ordering ist kritisch:** `install_name_tool`-Aufrufe müssen **vor** dem
     bestehenden codesign-Block (aktuell Zeile 54-58) eingefügt werden, damit
     der existierende `codesign --force --sign -`-Pass das modifizierte Binary
     mit-resigniert. `install_name_tool` invalidiert die Mach-O-Signatur — ein
     nicht oder ungültig signiertes Binary wird auf Apple Silicon von macOS
     beim Launch gekillt (`CODESIGNING, Code 2 Invalid Page`, siehe CLAUDE.md
     „Code signing"-Gotcha).
   - Konkreter Einfügepunkt (zwischen aktuellem Zeilenblock 47-52 und 54-58):
     ```bash
     # Rewrite absolute /opt/homebrew/opt/ggml/lib paths in llama-cli to
     # @rpath, so the bundled lib/ in this tool's directory is used at runtime
     # on end-user machines (where Homebrew may not exist at this prefix).
     install_name_tool -change \
       /opt/homebrew/opt/ggml/lib/libggml.0.dylib \
       @rpath/libggml.0.dylib \
       "$BIN_DIR/llama-cli"
     install_name_tool -change \
       /opt/homebrew/opt/ggml/lib/libggml-base.0.dylib \
       @rpath/libggml-base.0.dylib \
       "$BIN_DIR/llama-cli"

     # Sanity check: no absolute Homebrew paths must remain.
     if otool -L "$BIN_DIR/llama-cli" | grep -q '/opt/homebrew'; then
       echo "FATAL: llama-cli still references /opt/homebrew/... after install_name_tool" >&2
       otool -L "$BIN_DIR/llama-cli" >&2
       exit 1
     fi
     ```
   - Die bestehende `codesign --force --sign - "$BIN_DIR/llama-cli"`-Zeile
     (Zeile 55) bleibt unverändert stehen und resigniert das jetzt-modifizierte
     Binary mit. **Keine** zweite, redundante codesign-Zeile einfügen.

### Phase 2 — Main-Process Code & Tests

3. Pfad-Konstanten aktualisieren. Suchen:
   ```bash
   grep -rn "resources['\"]\s*,\s*['\"]bin['\"]\s*,\s*['\"](whisper\|llama)-cli\|resources/bin/whisper-cli\|resources/bin/llama-cli" src/
   ```

   **Drei Stellen müssen geändert werden (nicht zwei!):**

   a) [src/main/ml/WhisperService.ts:84-86](../../src/main/ml/WhisperService.ts#L84-L86):
      ```ts
      // packaged
      return join(process.resourcesPath, 'whisper', 'bin', 'whisper-cli')
      // dev
      return join(app.getAppPath(), 'resources', 'whisper', 'bin', 'whisper-cli')
      ```

   b) [src/main/index.ts:229-230](../../src/main/index.ts#L229-L230) (LLama-Pfad
      für den Summarization-Path):
      ```ts
      ? join(process.resourcesPath, 'llama', 'bin', 'llama-cli')
      : join(app.getAppPath(), 'resources', 'llama', 'bin', 'llama-cli'),
      ```

   c) [src/main/ml/__tests__/WhisperService.test.ts:153](../../src/main/ml/__tests__/WhisperService.test.ts#L153):
      ```ts
      const BINARY = join(repoRoot, 'resources', 'whisper', 'bin', 'whisper-cli')
      ```
      **Diese Stelle ist nicht optional.** Der Test existiert genau, um
      upstream-Renames von whisper-cli-Flags zu fangen — der „WhisperService
      flag compatibility"-Integration-Test. Wenn der hardcodierte Pfad nach
      dem Move falsch bleibt, `skip`t der Test leise weiter, und der
      Regressions-Schutz gegen das nächste „Brew hat einen Flag umbenannt" ist
      weg.

   Beachte den **Schema-Wechsel** der Path-Komponenten: aktuell
   `(resourcesPath|appPath)/[resources/]bin/X`, neu
   `(resourcesPath|appPath)/[resources/]<tool>/bin/X`. Das `bin/`-Segment
   bleibt — was sich ändert, ist der Parent-Dir.

   Kein env-Plumbing, kein cwd-Tricks: der eingebaute `LC_RPATH =
   @loader_path/../lib` findet die jeweilige tool-spezifische `lib/`-Schwester
   automatisch.

### Phase 3 — electron-builder

4. `electron-builder.yml` — `extraResources` aktualisieren. **Beide
   Felder (`from:` und `to:`) müssen geändert werden** — `process.resourcesPath`
   zeigt in der DMG auf `Contents/Resources/`, nicht auf einen `resources/`-
   Subdir. Wenn `to:` nicht passt, läuft die DMG nicht.

   Aktueller Block bei [electron-builder.yml:22-29](../../electron-builder.yml#L22-L29):
   ```yaml
   extraResources:
     - from: resources/bin
       to: bin
       filter:
         - '**/*'
     - from: resources/lib
       to: lib
       filter:
         - '**/*'
   ```

   Ersetzen durch:
   ```yaml
   extraResources:
     - from: resources/whisper
       to: whisper           # Contents/Resources/whisper/{bin,lib}
       filter:
         - '**/*'
     - from: resources/llama
       to: llama             # Contents/Resources/llama/{bin,lib}
       filter:
         - '**/*'
     - from: resources/bin/ffmpeg
       to: bin/ffmpeg        # Contents/Resources/bin/ffmpeg (unchanged path)
     - from: resources/bin/vision-ocr
       to: bin/vision-ocr    # Contents/Resources/bin/vision-ocr (unchanged path)
   ```

   Die `whisper`/`llama`-Top-Level-Dirs in `Contents/Resources/` matchen die
   Path-Logik aus Phase 2 (`join(process.resourcesPath, 'whisper', 'bin', ...)`).
   ffmpeg + vision-ocr bleiben unter `bin/` — die haben keine shared deps
   (verifiziert via `otool -L`: nur System-Frameworks + libc++/libSystem).

5. **Build-Verifikation** nach `npm run package`:
   ```bash
   find dist/mac/Therascript.app/Contents/Resources -name 'libggml*'
   # Erwartung: ZWEI Pfade
   #   .../Contents/Resources/whisper/lib/libggml*.dylib
   #   .../Contents/Resources/llama/lib/libggml*.dylib
   ls dist/mac/Therascript.app/Contents/Resources/{whisper,llama}/bin/
   # Erwartung: whisper-cli bzw. llama-cli existieren
   ls dist/mac/Therascript.app/Contents/Resources/bin/
   # Erwartung: ffmpeg + vision-ocr, KEIN whisper-cli/llama-cli mehr
   ```

### Phase 4 — Verification (must-pass vor Merge)

6. **Reihenfolge-Test (Bug-Repro):**
   ```bash
   rm -rf resources/whisper resources/llama
   ./scripts/setup-whisper.sh
   ./scripts/setup-llama.sh
   ./resources/whisper/bin/whisper-cli --help     # darf nicht crashen
   ./resources/llama/bin/llama-cli --version      # darf nicht crashen
   ./scripts/setup-whisper.sh                     # nochmal in umgekehrter Reihenfolge
   ./resources/llama/bin/llama-cli --version      # immer noch nicht crashen
   ```

7. **Integrations-Test darf nicht skippen:**
   ```bash
   npx vitest run src/main/ml/__tests__/WhisperService.test.ts
   ```
   Erwartung: Der `whisper-cli flag compatibility`-Block läuft (nicht „skipped"
   wegen fehlender Binary). Falls skip → Pfad in der `.test.ts` wurde nicht
   aktualisiert (Phase 2c vergessen).

8. **End-to-End:** kurze Test-Aufnahme durch die Audio-Pipeline + manuelle
   Summarization triggern. Beides muss durchlaufen.

9. **DMG-Smoke:** `npm run package`, DMG mounten, auf einem zweiten Mac
   (idealerweise ohne Homebrew an `/opt/homebrew/opt/ggml/lib/`) starten und
   beide Pipelines durchlaufen lassen. Adressiert die `llama-cli`-absolute-
   Pfad-Verschärfung (#2 oben).

### Phase 5 — Doku & Guard

10. **`CLAUDE.md`** unter „Gotchas" ergänzen:
   > whisper.cpp und llama.cpp linken gegen inkompatible ggml-Generationen
   > (whisper-cpp 1.8.3 → ggml 0.9.5, llama.cpp 8940 → ggml 0.10.0). Deshalb
   > getrennte Bundles unter `resources/whisper/` und `resources/llama/`. Nie
   > auf eine gemeinsame `resources/lib/` zurückgehen — siehe
   > `docs/plans/ggml-abi-split.md`.

11. `scripts/verify-bundles.sh` — implementiert. Läuft als pre-package-Smoke,
    prüft beide Bundles via `otool -L`: zero `/opt/homebrew`-Refs in jeglichem
    Mach-O, alle Plugins + libssl/libcrypto/libomp vorhanden. Failed-Exit
    blockt einen DMG-Build der auf Endnutzer-Macs nicht laden würde.

---

## Erweiterung (Phase 6 — nach Code-Review)

Der erste Wurf des Plans hat nur die `llama-cli`-Binary auf `@rpath` umgeschrieben.
Code-Review (PR #111) hat aufgedeckt, dass die bundled **dylibs selbst** noch
absolute `/opt/homebrew`-Refs hatten, plus dass ggml 0.10+ Backend-Plugins zur
Laufzeit dlopen't. Erweiterungen:

### Comprehensive `rewrite_macho` Helper

Statt zwei hardcoded `install_name_tool -change`-Aufrufe für `libggml.0` und
`libggml-base.0`: eine Funktion in beiden Setup-Skripten, die `otool -L` parst
und JEDE absolute `/opt/homebrew`-Dep auf `@rpath/<basename>` umschreibt
(plus LC_ID der dylibs auf `@rpath/<basename>` für dyld-Dedup-Konsistenz).
Iteriert über `$LIB_DIR/*.dylib` und `$LIB_DIR/*.so` (Backend-Plugins).

### Transitive Dependencies bundlen

`libllama-common.0.dylib` → `libssl.3.dylib` + `libcrypto.3.dylib`
(macOS hat kein system-libssl mehr seit 10.15).
`libggml-cpu-apple_m*.so` → `libomp.dylib`.
Beide aus `$(brew --prefix openssl@3)/lib/` bzw. `$(brew --prefix libomp)/lib/`
ins llama-Bundle kopiert + via `rewrite_macho` portabilisiert.

### ggml Backend-Plugin Architektur

ggml 0.10+ lädt Backend-Implementierungen (Metal/BLAS/CPU-Varianten pro
Apple-Silicon-Generation) nicht statisch via `LC_LOAD_DYLIB`, sondern via
`dlopen` zur Laufzeit. `otool -L` sieht das nicht — empirisch entdeckt via
`DYLD_PRINT_LIBRARIES=1 ./llama-cli --version`. Die `.so` files in
`$(brew --prefix ggml)/libexec/` (NICHT `/lib/`) werden ins llama-Bundle
mitkopiert.

`libggml.0.dylib` enthält einen **hardcoded fallback** Suchpfad
`/opt/homebrew/Cellar/ggml/<ver>/libexec` als Konstante. Versuche, diesen
String via Binary-Patch auf `@loader_path` zu rewriten, schlugen fehl: ggml
ruft `std::filesystem::exists()` vor `dlopen`, behandelt `@loader_path` als
literalen Dirname (Fehlerstring `%s: search path %s does not exist`).
**Lösung:** Beim Spawnen von `llama-cli` setzt `LlamaSummarizer.ts` die env
var `GGML_BACKEND_PATH=<bundle>/lib`. Auf Endnutzer-Macs (kein
`/opt/homebrew/...`) fällt ggml auf diesen Pfad zurück und findet unsere
Plugins. Auf Dev-Macs werden beide Pfade gefunden — harmlos.

### Empirische Validation auf Dev-Mac begrenzt

Vollständige Portabilitäts-Validierung erfordert einen Clean Mac ohne
Homebrew (oder Docker-macos-VM). Auf einem Dev-Mac mit installiertem
Homebrew lädt ggml's hardcoded Pfad immer noch sichtbare `/opt/homebrew`-
Plugins — das ist erwartet und kein Bug. `verify-bundles.sh` deckt die
strukturelle Korrektheit ab (kein Mach-O referenziert `/opt/homebrew`).
Endgültiger Funktionsbeweis bleibt der DMG-Smoke auf einem zweiten Mac
(Test-plan-Item).

