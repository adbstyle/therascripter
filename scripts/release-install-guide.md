<!-- Diese Datei wird von scripts/release.sh an JEDE GitHub-Release-Note
     angehängt. Zielgruppe: technisch nicht versierte Endanwender.
     Dieselbe Anleitung steht auf der Website (website/installation.html), im
     README («Installation») und in Kurzform im DMG-Fenster
     (build/dmg-background.svg). Schritte und Fakten (macOS-Floor, Modellgrösse,
     Speicherplatz) an allen Stellen gleich halten. Sie-Form, Schweizer
     Rechtschreibung, keine Fachbegriffe wie Gatekeeper, Quarantäne oder
     Notarisierung (Epic #156). -->

## 📦 Installationsanleitung

**Systemvoraussetzungen:** Mac mit Apple-Chip (M1 oder neuer), macOS 26 (Tahoe) oder neuer, mindestens 8 GB Arbeitsspeicher, ca. 5 GB freier Speicherplatz. Beim ersten Start lädt Therascript die Sprachmodelle herunter (~1.7 GB), dafür braucht es eine Internetverbindung.

Ausführliche Anleitung mit Erklärungen: https://adbstyle.github.io/therascripter/installation.html

### Schritt 1: Herunterladen und in «Programme» ziehen

1. Unten bei **Assets** auf `Therascript.dmg` klicken und die Datei herunterladen.
2. Die Datei `Therascript.dmg` doppelklicken. Ein Fenster öffnet sich.
3. Das Therascript-Symbol auf den Ordner **Programme** ziehen.
4. Das Fenster schliessen.

### Schritt 2: Therascript zum ersten Mal öffnen

1. Therascript im Ordner **Programme** doppelklicken.
2. macOS meldet: *«Therascript» wurde nicht geöffnet. Apple konnte nicht überprüfen, ob die App frei von Schadsoftware ist.* Diese Meldung ist erwartet.
3. Auf **Fertig** klicken, **nicht** auf «In den Papierkorb legen».

### Schritt 3: Programm-Freigabe erteilen (einmalig)

Mit der Programm-Freigabe erlauben Sie macOS, Therascript zu starten. Erledigen Sie diesen Schritt direkt nach Schritt 2: macOS bietet die Freigabe nur kurze Zeit nach dem blockierten Start an. Fehlt der Hinweis zu Therascript, öffnen Sie Therascript erneut (Schritt 2) und kehren gleich danach hierher zurück.

1. Oben links auf das Apple-Symbol klicken und **Systemeinstellungen** wählen.
2. Links auf **Datenschutz & Sicherheit** klicken und rechts ganz nach unten scrollen.
3. Beim Hinweis zu Therascript auf **Dennoch öffnen** klicken.
4. Mit Ihrem Passwort oder Touch ID bestätigen. Fragt macOS noch einmal nach, erneut **Dennoch öffnen** wählen.

Therascript startet und lädt beim ersten Start die Sprachmodelle herunter (je nach Internetverbindung 5–15 Minuten). Der Fortschritt wird angezeigt.

### Warum die Programm-Freigabe nötig ist

Apple bestätigt Apps nur gegen eine jährliche Gebühr als geprüft. Therascript ist kostenlos und quelloffen und verzichtet deshalb auf diese Beglaubigung. Darum warnt macOS beim ersten Start.

- **Was die Programm-Freigabe bewirkt:** Sie erlauben macOS, diese Version von Therascript zu starten. Die Freigabe gilt für die ganze App, auch für die eingebauten Werkzeuge für Transkription, Sprechererkennung, Pseudonymisierung, Texterkennung und Zusammenfassung. Ein Terminal ist nicht nötig.
- **Was niemand unabhängig bestätigt:** Ohne Beglaubigung prüft weder Apple noch eine andere Stelle, dass die heruntergeladene Datei wirklich vom Therascript-Projekt stammt. Laden Sie Therascript deshalb nur über die Website https://adbstyle.github.io/therascripter/ oder die Release-Seite auf GitHub. Der Quellcode ist öffentlich einsehbar.

### Auf eine neue Version aktualisieren

1. Therascript beenden: in der Menüleiste oben rechts auf das Therascript-Symbol klicken und **Therascript beenden** wählen, oder im geöffneten Fenster `⌘ Q` drücken. Das Schliessen des Fensters allein beendet die App nicht.
2. Die neue Version wie in Schritt 1 herunterladen und auf den Ordner **Programme** ziehen. Auf die Frage, ob die vorhandene App ersetzt werden soll, mit **Ersetzen** antworten.
3. Schritt 2 und 3 wiederholen. Jede heruntergeladene Version braucht die Programm-Freigabe einmal.

Ihre Transkriptionen, Einstellungen und die heruntergeladenen Modelle bleiben erhalten. Beim ersten Update auf eine Version, die Ihre Berechtigungen über Updates hinweg behält, kann macOS einmalig zwei Rückfragen stellen: Erlauben Sie den Zugriff auf das Mikrofon, damit Aufnahmen weiter funktionieren. Fragt macOS, ob Therascript auf den Schlüsselbund zugreifen darf, wählen Sie **Immer erlauben** und bestätigen mit Ihrem Passwort. Spätere Updates fragen nicht mehr.
