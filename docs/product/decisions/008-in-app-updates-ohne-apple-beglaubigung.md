# ADR-008: Updates in der App und Installation ohne Terminal (ohne Apple-Beglaubigung)

**Status:** Accepted
**Datum:** 2026-10-10
**Spike:** Issue #157 (Epic #156)
**Löst ab:** die Konsequenz «Kein Auto-Updater» in ADR-001 und ADR-005, die Entscheidungen #131/#155 und Out of Scope 1 aus Issue #18

## Kontext

Therascript wird als ad-hoc-signiertes, nicht von Apple beglaubigtes DMG über GitHub Releases verteilt. Das Apple Developer Program bleibt ausgeschlossen (PO-Entscheid 2026-10-10). Ein Update bedeutete bisher: DMG im Browser laden, App im Programme-Ordner ersetzen, Terminal-Befehl `chmod -R u+w … && xattr -cr …` ausführen, neu starten. Begründet wurde der Terminal-Schritt mit PR #125: «Rechtsklick → Öffnen» gebe nur den App-Start frei, die eingebetteten Werkzeuge (whisper-cli, llama-cli, Python-Sidecar, vision-ocr) würden beim Start per SIGKILL beendet.

Epic #156 verlangt Updates vollständig in der App, eine Erstinstallation ohne Terminal und einen Echtheitsnachweis für Updates, der auch einem kompromittierten Download-Server standhält. Der Spike #157 hat geklärt, was davon ohne Apple-Beglaubigung auf macOS 26 möglich ist.

## Befunde des Spikes

Testumgebung: macOS 26.5, Apple Silicon, selbstverwaltetes Konto mit Administratorrechten, 2026-10-10. Geprüft mit einem Prototyp («QTest»: ad-hoc-signierte App mit einem separat ad-hoc-signierten Hilfsprogramm unter `Contents/Resources/bin`, also gleich aufgebaut wie Therascript) und mit der echten App 0.8.13. Die Downloads liefen über einen echten Browser, damit die Quarantäne-Markierung gesetzt war. Gestartet wurde über den Finder bzw. LaunchServices.

**Wichtig für jede künftige Prüfung:** Aus einer Entwickler-Shell gestartet, liefen quarantänisierte Werkzeuge auch ohne jede Freigabe. Gatekeeper lässt sich nur über einen echten App-Start prüfen, nicht per Skript im Terminal.

1. **Erstinstallation:** macOS 26 blockiert den ersten Start mit «"Therascript" Not Opened — Apple could not verify "Therascript" is free of malware that may harm your Mac or compromise your privacy.» Die Knöpfe sind «Done» und «Move to Bin». Danach zeigt Systemeinstellungen → Datenschutz & Sicherheit den Knopf «Dennoch öffnen». Nach dieser Freigabe setzt macOS die Freigabe-Markierung (`com.apple.quarantine` mit Flag 0x40, z. B. `03c1;…`) auf **alle** Dateien des Bundles, bei 0.8.13 auf alle 17'088. Anschliessend liefen in der echten App fehlerfrei und **ohne Terminal**: Sprechererkennung, Transkription, Pseudonymisierung, Zusammenfassung (llama-cli) und Texterkennung eines Bild-PDFs (vision-ocr). Geprüft mit einer 15-Sekunden-Aufnahme, einem Text-PDF und einem Bild-PDF, alle drei erreichten «review» mit Zusammenfassung.
2. **Vermutliche Ursache des Befunds aus PR #125:** Die Freigabe wird pro Datei als Attribut geschrieben. Bis 0.8.7 waren einzelne Mach-Os schreibgeschützt (Modus 444/555). Dort konnte die Markierung nicht auf «freigegeben» wechseln, die Werkzeuge wurden beendet. Seit 0.8.8 erzwingen `afterPack.js` und `verify-bundles.sh` das Owner-Write-Bit. Das u+w-Gate ist damit zugleich die Voraussetzung dafür, dass «Dennoch öffnen» genügt. Mit einem 0.8.7-Build nachgestellt wurde das nicht.
3. **Selbst geladene Dateien:** Eine per Node-`https` geladene Datei trägt keine Quarantäne-Markierung (`LSFileQuarantineEnabled` ist nicht gesetzt). Eine nicht markierte, ad-hoc-signierte App startet ohne Gatekeeper-Rückfrage. Ein Update aus der App löst also keine Sperre aus, wird aber auch von macOS nicht geprüft.
4. **Eigene Quarantäne entfernen:** Die laufende App kann die Quarantäne-Markierung ihres eigenen Bundles in `/Applications` ohne Rückfrage entfernen. Es erschien kein Hinweis zur App-Verwaltung.
5. **Selbst-Update:** Die laufende App kann sich in `/Applications` umbenennen (`.previous`), die neue Version an ihren Platz verschieben und diese starten. Dabei kam weder eine Rückfrage noch ein Hinweis zur App-Verwaltung, und die Systemeinstellungen wurden nicht gebraucht. Bedingung: Das Bundle gehört der Nutzer:in, sie hat Administratorrechte.
6. **Rückweg:** Der Tausch mit `.previous` funktioniert, die Vorversion startet wieder und hat ihre alten Berechtigungen.
7. **Mikrofon-Berechtigung:** Bei der Standard-Ad-hoc-Signatur hängt sie am CDHash. Sie geht mit jedem Update verloren («nicht festgelegt»). Mit der expliziten Designated Requirement `designated => identifier "<bundle-id>"` bleibt sie über Builds hinweg erhalten: QTest 3.0 → 4.0 meldete «erlaubt», ohne erneut zu fragen. Der Umstieg auf diese Signatur verlangt einmalig eine neue Freigabe. Für den Schlüsselbund-Eintrag von Electron («Safe Storage») gilt vermutlich dasselbe, getestet ist das nicht.
8. **Echtheitsnachweis:** Electron 34 (BoringSSL) kann Ed25519-Signaturen ohne Zusatzbibliothek erzeugen und prüfen. Ein manipuliertes Manifest wird abgelehnt.
9. Electrons eingebauter Updater (Squirrel.Mac, auch hinter electron-updater) setzt eine Developer-ID-Signatur voraus und kommt deshalb nicht in Frage. Das ist Plattformwissen, im Spike nicht geprüft.

## Entscheidung

1. **App-Updates werden in der App bezogen.** Der Main-Prozess lädt die neue Version, prüft sie, ersetzt das eigene Bundle an Ort und Stelle und startet neu. Der Ablauf folgt den PO-Entscheiden in Epic #156: Rückfrage vor dem Neustart, nie während einer Aufnahme oder eines laufenden Verarbeitungsschritts, automatische Updates standardmässig an und abschaltbar.
2. **Rückweg:** Die Vorversion bleibt erhalten, bis die neue Version erfolgreich gestartet ist. Danach dient sie als Weg zurück.
3. **Echtheit:** Jede Version wird über ein mit Ed25519 signiertes Update-Manifest beschrieben: Version, Grösse und SHA-256 des Artefakts. Der öffentliche Schlüssel ist in der App eingebaut. Den privaten Schlüssel hat nur der Herausgeber, offline und mit Sicherung. Die App installiert nur, was die Signatur bestätigt, und nur Versionen, die neuer sind als die installierte. So lässt sich keine ältere, echte Version unterschieben. Verhältnismässigkeit (Vorgabe PO: nicht überinvestieren):
   - **Schutz gegen Rückstufung:** umgesetzt, kostet nur einen Versionsvergleich.
   - **Modell-Updates:** Dasselbe signierte Manifest kann sie ohne Mehraufwand mit abdecken. Empfohlen, Umsetzung in einer eigenen Story.
   - **Prüfbarkeit der DMG bei der Erstinstallation:** verworfen. Für Laien bräuchte sie ein Terminal und brächte keinen Nutzen.
4. **Signatur:** Die App wird weiterhin ad-hoc signiert, aber mit der Designated Requirement `designated => identifier "<bundle-id>"`. So überstehen die Mikrofon-Berechtigung und voraussichtlich der Schlüsselbund-Zugriff ein Update. Abwägung: Eine andere ad-hoc-signierte App mit derselben Bundle-ID könnte diese Berechtigungen erben. Wer aber schon Code unter dem Konto der Nutzer:in ausführt, kann die Daten in `~/.therascript` ohnehin lesen. Das zusätzliche Risiko ist gering.
5. **Erstinstallation:** Der dokumentierte Weg ist «Dennoch öffnen» in den Systemeinstellungen, der Terminal-Befehl entfällt. Voraussetzung bleibt das Owner-Write-Bit auf allen Dateien, abgesichert durch das Release-Gate in `verify-bundles.sh`.
6. **Sicherheitsnetz:** Die App prüft beim Start, ob ihre eingebetteten Werkzeuge noch eine nicht freigegebene Quarantäne-Markierung tragen. Hat die Nutzer:in die App freigegeben, darf die App diese Markierung selbst entfernen. Andernfalls erklärt sie den Weg zur Freigabe (Epic #156, Story «Blockierte Werkzeuge erkennen»).

## Konsequenzen

- **Netzwerk:** Die Konsequenz «Kein Auto-Updater» aus ADR-001 und ADR-005 ist abgelöst. Der Renderer bleibt ohne Netzwerkzugang (`connect-src 'none'`). Netzwerkzugriffe gibt es weiterhin nur im Main-Prozess, neu kommt der Download des App-Artefakts hinzu. Die öffentlichen Aussagen zur Internetverbindung werden angepasst (Epic #156).
- **Bestehende Installationen:** Installationen ohne Updater wechseln einmalig von Hand auf die erste Version mit Updater.
- **Mikrofon:** Mit der Umstellung auf die neue Designated Requirement fragt macOS einmalig erneut nach der Mikrofon-Berechtigung. Die App klärt das direkt nach dem Neustart.
- **Release:** Jedes Release veröffentlicht ein signiertes Manifest. Eine Version wird erst angeboten, wenn Artefakt und Manifest vollständig abrufbar sind.
- **Anleitungen:** Release-Text, README, DMG-Hintergrundbild und Website werden auf «Dennoch öffnen» umgestellt (Epic #156, Story Installationsanleitung). Die Anleitung muss die Malware-Meldung vorwegnehmen, denn sie bietet nur «Done» und «Move to Bin» an.

## Prüfung vor jedem Release

- **Automatisch (bestehend):** `verify-bundles.sh` schlägt bei Dateien ohne Owner-Write-Bit fehl. Diese Prüfung entscheidet jetzt auch darüber, ob die Erstinstallation ohne Terminal klappt.
- **Manuell:** Die Gatekeeper-Prüfung geht nicht per Skript (siehe Befunde). Ablauf:
  1. DMG über einen Browser laden und über den Finder installieren.
  2. «Dennoch öffnen» bestätigen.
  3. Ein Text-PDF, ein Bild-PDF und eine kurze Aufnahme verarbeiten. Alle drei Sitzungen müssen «review» mit Zusammenfassung erreichen.
  4. Mit Updater zusätzlich: Update aus der Vorversion in der App durchführen. Die Mikrofon-Berechtigung muss bleiben, der Rückweg muss funktionieren.

## Offen für die Umsetzung

- Selbst-Update mit der echten App (~1 GB, ~17'000 Dateien) prüfen: Ablage der neuen Version auf demselben Volume, Austausch bei laufendem Electron-Prozess.
- Schlüsselbund-Eintrag «Safe Storage» über ein Update.
- App- und Modell-Update als ein Vorgang.
- Sauber abbrechen, wenn das Bundle nicht der Nutzer:in gehört oder nicht in `/Applications` liegt. Dieser Fall liegt ausserhalb der Zielgruppe.
