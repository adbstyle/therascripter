# ADR-001: Vollständig lokale Verarbeitung

**Status:** Accepted
**Datum:** 2025-02

## Kontext

Therascript verarbeitet hochsensible Therapiesitzungen — Audiodaten und Transkripte, die dem Berufsgeheimnis (StGB Art. 321) und der DSGVO unterliegen. Therapeuten benötigen eine Lösung, bei der keine Patientendaten das Gerät verlassen. Cloud-basierte Transkriptionsdienste (z.B. OpenAI Whisper API, Google Speech-to-Text) scheiden aus, da sie Audiodaten an externe Server übertragen und damit die gesetzlichen Anforderungen verletzen.

## Entscheidung

Alle Verarbeitung — ASR, Diarization, NER-Anonymisierung und OCR — erfolgt ausschliesslich lokal auf dem Mac des Therapeuten. Die Produktions-CSP setzt `connect-src 'none'` im Renderer-Prozess, um jegliche Netzwerk-Requests technisch zu unterbinden (NFR-1, NFR-12). Modell-Updates werden ausschliesslich im Main Process via `net.fetch()` heruntergeladen; der Renderer hat keinen Netzwerkzugang.

## Begründung

- **Regulatorische Compliance:** DSGVO und Berufsgeheimnis verlangen, dass Patientendaten nicht an Dritte übermittelt werden. Lokale Verarbeitung eliminiert dieses Risiko vollständig.
- **Kein Vertrauen in Dritte nötig:** Keine AGB-Änderungen, keine Datenpannen bei Cloud-Anbietern, keine Abhängigkeit von Internetverbindung.
- **Technische Durchsetzung:** `connect-src 'none'` in der CSP ist keine Policy, sondern eine harte technische Barriere — selbst kompromittierter Renderer-Code kann keine Daten exfiltrieren.
- **Alternative verworfen — Cloud-APIs:** Niedrigere Hardwareanforderungen und kein grosser Modell-Download, aber inkompatibel mit den Datenschutzanforderungen.
- **Alternative verworfen — Hybrid (lokal + Cloud-Fallback):** Komplexere Architektur, und bereits ein optionaler Cloud-Pfad untergräbt das Sicherheitsversprechen.

## Konsequenzen

- **Grosse Modell-Downloads:** ~4.1 GB beim Erststart (Whisper 1.7 GB, pyannote 0.2 GB, flair NER 2.2 GB).
- **Hohe Hardwareanforderungen:** Minimum 8 GB RAM, Apple Silicon (M1+), macOS 26 (Tahoe) oder neuer (Pyannote-Sidecar benötigt Systembibliotheken aus macOS 26+). Ältere Intel-Macs werden nicht unterstützt.
- **Längere Verarbeitungszeit:** Lokale ML-Inferenz braucht ~21-40 Minuten für eine 60-Minuten-Sitzung (M3 8 GB), statt Sekunden bei Cloud-APIs.
- **Sequenzielle Pipeline:** Nur ein ML-Modell gleichzeitig geladen (8 GB RAM-Constraint), was die Gesamtdauer erhöht.
- **Kein Auto-Updater:** Electron Auto-Updater deaktiviert; Updates via manuellen DMG-Download.
- **Spotlight-Ausschluss, FileVault-Check, chmod 700:** Ergänzende Massnahmen zum Schutz der lokalen Daten.
