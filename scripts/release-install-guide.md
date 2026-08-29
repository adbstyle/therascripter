<!-- Diese Datei wird von scripts/release.sh an JEDE GitHub-Release-Note
     angehängt. Zielgruppe: technisch nicht versierte Endanwender.
     Fakten (macOS-Floor, Modellgrösse, Speicherplatz, Gatekeeper-Befehl)
     müssen mit README.md → «Systemvoraussetzungen»/«Installation»
     übereinstimmen — bei Änderungen beide Stellen anpassen. -->

## 📦 Installationsanleitung

**Systemvoraussetzungen:** Mac mit Apple-Chip (M1–M4), macOS 26 (Tahoe) oder neuer, mindestens 8 GB Arbeitsspeicher, ca. 7 GB freier Speicherplatz. Für den ersten Start wird eine Internetverbindung benötigt (Modell-Download, ~4.1 GB) — danach arbeitet Therascript vollständig offline. Bei der ersten Anonymisierung legt Therascript einmalig eine ~2.1 GB grosse, schneller ladbare Kopie des Namenserkennungs-Modells an; ist zu wenig Platz frei, wird sie übersprungen und alles läuft wie bisher, nur langsamer.

### Schritt 1: Herunterladen und installieren

1. Unten bei **Assets** auf `Therascript.dmg` klicken und die Datei herunterladen.
2. Die heruntergeladene Datei `Therascript.dmg` doppelklicken — ein Fenster öffnet sich.
3. Das Therascript-Symbol in den Ordner **Programme** ziehen.
4. Das Fenster schliessen.

### Schritt 2: App freigeben (einmalig, wichtig!)

macOS blockiert Apps, die nicht aus dem App Store stammen. Damit Therascript vollständig funktioniert, muss die App einmalig freigegeben werden:

1. **Terminal** öffnen: Tastenkombination `cmd + Leertaste` drücken, „Terminal" eintippen, mit `Enter` bestätigen.
2. Die folgende Zeile kopieren, im Terminal einfügen und `Enter` drücken:
   ```
   chmod -R u+w /Applications/Therascript.app && xattr -cr /Applications/Therascript.app
   ```
3. Das Terminal kann danach geschlossen werden.

> ⚠️ **Wichtig:** „Rechtsklick → Öffnen" allein genügt **nicht** — damit startet zwar die App, aber die eingebauten Verarbeitungs-Werkzeuge bleiben blockiert und die Transkription schlägt fehl. Bitte immer den Terminal-Befehl aus Schritt 2 verwenden.

### Schritt 3: Starten

1. Therascript aus dem Ordner **Programme** (oder über das Launchpad) starten.
2. Beim ersten Start lädt die App die benötigten Sprachmodelle herunter (~4.1 GB, je nach Internetverbindung 10–30 Minuten). Der Fortschritt wird angezeigt.
3. Fertig — ab jetzt arbeitet Therascript komplett lokal auf Ihrem Mac, ohne Cloud.

**Update von einer früheren Version:** Einfach Schritt 1 und 2 wiederholen (alte App im Programme-Ordner ersetzen). Ihre Transkriptionen, Einstellungen und die bereits heruntergeladenen Modelle bleiben erhalten.
