# Landing Page

Die Landing Page liegt unter `website/` und wird unter
<https://adbstyle.github.io/therascripter/> veröffentlicht. Sie ist statisch. Das einzige
Skript, `site.js`, schliesst das mobile Menü nach einem Klick; ohne Skript funktioniert alles,
das Menü bleibt dann nur offen, bis man es selbst schliesst.

## Aufbau

- **Sticky Header auf allen Seiten:** Logo, Ankernavigation (Funktionen, Datenschutz, Fragen,
  Installation) und der Knopf «Kostenlos herunterladen» bleiben beim Scrollen sichtbar. Unter
  880 px wandert die Navigation in ein `<details>`-Menü, unter 560 px heisst der Knopf nur
  «Herunterladen». `scroll-padding-top` hält Anker-Ziele unter dem Header.
- **Download-Knöpfe** führen auf `installation.html`; nur dort lädt der Header-Knopf direkt die
  DMG.
- **Download-Bänder** (`.cta-band`) wiederholen den Knopf zwischen den Sektionen der Startseite.
- **«In 3 Schritten startklar»** auf der Startseite ist die Kurzform der Installationsanleitung.
  Schritte und Fakten synchron halten mit `installation.html`, `scripts/release-install-guide.md`,
  README und `build/dmg-background.svg` (siehe [Release](release.md)).

## Veröffentlichung

`.github/workflows/publish-website.yml` läuft bei jedem Push auf `main`, der `website/**`
ändert, und bei Pull Requests:

1. **Lighthouse CI** (`website/.lighthouserc.json`): Startseite, Impressum und
   Installationsanleitung. Performance und Best Practices müssen mindestens 0.9 bzw. 0.95
   erreichen, Barrierefreiheit 0.95, SEO (ohne Impressum) 0.95. Grenzen: LCP unter 2 s, CLS
   unter 0.1.
2. **Deploy** nach `gh-pages` (nur auf `main`). Die Seite deployt unabhängig von App-Releases.

## Bilder und Animationen

Alle Bilder zeigen eine frei erfundene Demo-Sitzung (Epic #172). Echte oder pseudonymisierte
Patientendaten gehören nie in ein Bild, auch nicht zu Testzwecken.

| Datei in `website/assets/` | Inhalt | Entsteht mit |
| --- | --- | --- |
| `editor-{light,dark}.webp` | Hero: Editor mit Chips, Zusammenfassung und Seitenleiste | `capture.mjs stills` |
| `sprecher-{light,dark}.webp` | Transkript mit drei Gesprächsbeteiligten | `capture.mjs stills` |
| `sitzungen-{light,dark}.webp` | Übersicht «Transkriptionen» | `capture.mjs stills` |
| `aufnahme-{light,dark}.gif` | Aufnahme bis pseudonymisiertes Transkript | `capture.mjs aufnahme` |
| `editor-{light,dark}.gif` | Begriff markieren und in die Sperrliste aufnehmen | `capture.mjs editor` |
| `pdf-{light,dark}.gif` | PDF-Import (Scan) bis pseudonymisierter Text | `capture.mjs pdf` |
| `*-ende.webp` | Endzustand jeder Animation, für reduzierte Bewegung | `build-gifs.sh` |
| `og-image.png` | Link-Vorschau (Logo, Name, Kernbotschaft) | `render-og-image.sh` |

Die Seite wählt die Variante per `<picture>`: `prefers-color-scheme` für hell/dunkel,
`prefers-reduced-motion` für das Standbild statt des GIFs. Die GIFs laufen in Schleife und
bleiben am Ende 5 s auf dem Endzustand stehen (`END_PAUSE` in `build-gifs.sh`): Ein GIF startet
beim Laden, und lazy lädt der Browser schon deutlich vor dem sichtbaren Bereich – einmal
abgespielt sähen Besucher:innen oft nur das Ende. Anhalten lassen sich die Animationen nicht;
die Abweichung von WCAG 2.2.2 ist bewusst akzeptiert (Epic #172), damit die Seite nicht von
Skripten abhängt.

### Demo-Sitzung neu erstellen

Quellen in `scripts/website/demo/`: Gesprächsskripte (`sitzungen.json`), Überweisungsbericht
(`bericht.html`) und Sperrliste (`sperrliste.json`).

```bash
npm run build
node scripts/website/demo/build-demo-assets.mjs /tmp/demo-assets
scripts/website/demo/start-demo-instance.sh /tmp/demo
CDP_PORT=9224 node scripts/website/demo/load-demo.mjs /tmp/demo-assets --db /tmp/demo/home/.therascript/data/therascript.db
```

- `start-demo-instance.sh` startet eine eigene Instanz mit eigenem Daten- und Settings-Ordner.
  `HOME` umzubiegen reicht nicht: Electron löst `app.getPath('home')` auf macOS nicht über
  `$HOME` auf, die App schrieb so in die echten Daten unter `~/.therascript`. Der Wrapper
  setzt die Pfade per `app.setPath`, bevor der Main-Prozess startet.
- Die Stimmen sind macOS-`say` «Anna», je Person in der Tonhöhe verschoben. Die übrigen
  deutschen `say`-Stimmen (Reed, Flo, Rocko, Sandy …) versteht Whisper kaum.
- `load-demo.mjs` und `capture.mjs` brechen ab, wenn die Instanz die echten Daten unter
  `~/.therascript` nutzt (`demo/guard.mjs`); `load-demo.mjs` zusätzlich, wenn sie schon
  Sitzungen hat.
- Die Modelle werden beim ersten Start per APFS-Klon aus `~/.therascript/models` übernommen.

### Bilder aufnehmen

```bash
CDP_PORT=9224 node scripts/website/capture.mjs stills /tmp/cap
CDP_PORT=9224 node scripts/website/capture.mjs editor /tmp/cap
CDP_PORT=9224 node scripts/website/capture.mjs pdf /tmp/cap /tmp/demo-assets/bericht-scan.pdf
# Aufnahme-Animation: Instanz mit Fake-Mikrofon neu starten
scripts/website/demo/start-demo-instance.sh /tmp/demo --fake-mic /tmp/demo-assets/aufnahme-animation.wav
CDP_PORT=9224 node scripts/website/capture.mjs aufnahme /tmp/cap
scripts/website/build-gifs.sh /tmp/cap
```

- Die Aufnahme läuft über CDP mit echten Maus-Events auf der echten Oberfläche. Der
  Screencast enthält nur den Fensterinhalt; Ampel-Knöpfe und Mauszeiger blendet
  `capture.mjs` als Overlay ein.
- Ohne Bildschirmaufnahme-Berechtigung des Terminals ist `screencapture -l` keine Option,
  deshalb CDP.
- Die Animationen räumen ihre Sitzungen und Sperrlisten-Einträge danach wieder ab.

## Inhalte pflegen

- Jede Funktionsaussage muss auf die veröffentlichte App zutreffen. Bei UI-Änderungen
  Bilder neu aufnehmen.
- Die Lizenzübersicht `THIRD_PARTY_LICENSES.md` im Repository-Root ist von der Seite
  verlinkt. Neue Modelle oder Abhängigkeiten dort nachführen.
- Nach einem neuen `og-image.png` den Cache-Buster `?v=N` am `og:image` erhöhen.
