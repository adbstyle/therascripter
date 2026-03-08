# ADR-004: flair NER + Hybrid-Pipeline für Anonymisierung

**Status:** Accepted
**Datum:** 2025-02

## Kontext

Therapie-Transkripte müssen vor dem Export anonymisiert werden — personenbezogene Daten (Namen, Orte, Daten, Kontaktdaten) durch Platzhalter ersetzt. Die Erkennung muss auf Deutsch zuverlässig funktionieren, auch bei gesprochener Sprache mit Dialekteinflüssen. Ein einzelnes NER-Modell reicht nicht aus: Telefonnummern, AHV-Nummern und andere strukturierte Formate werden von NER-Modellen nicht zuverlässig erkannt.

## Entscheidung

Dreistufige Hybrid-Pipeline: flair NER + Regex-Engine + Sperrliste (Blocklist). Die Ergebnisse werden in einem Merger mit NER-Vorrang zusammengeführt (Entscheidung #68).

**Primäres NER-Modell: flair/ner-german-large**

| Eigenschaft | Wert |
|-------------|------|
| Architektur | XLM-RoBERTa Large + FLERT (document-level context) |
| F1 (CoNLL-2003 DE) | ~92.31% |
| F1 (GermEval 2014) | ~90%+ |
| Entitätstypen | PER, LOC, ORG, MISC |
| Modellgrösse | ~2.2 GB (XLM-R Large) |
| Lizenz | MIT |

**ORG-Entities werden ignoriert** (Entscheidung #5/#158): Zu viele False Positives bei Institutionsnamen. Organisationen werden ausschliesslich über die Sperrliste oder manuelle Markierung erfasst.

## Begründung

- **Bestes F1 auf Deutsch:** ~92% F1 auf CoNLL-2003 DE — kein anderes verfügbares Modell erreicht diesen Wert.
- **Document-Level Context (FLERT):** Nutzt den gesamten Dokumentkontext statt nur den lokalen Satz — ideal für lange Therapie-Transkripte, wo Namen im Verlauf des Gesprächs wiederkehren.
- **Hybrid-Ansatz:** Regex fängt strukturierte Formate ab (AHV-Nr, Telefon, Email, Geburtsdatum, Adressen), die NER-Modelle nicht zuverlässig erkennen. Sperrliste erlaubt Therapeuten, wiederkehrende Namen und Begriffe zu pflegen.
- **Merger mit NER-Vorrang:** Bei Überlappungen hat flair Vorrang — Sperrliste ergänzt nur, was NER nicht erkennt. Herkunft wird pro Platzhalter gespeichert (`ner`, `blocklist`, `manual`).
- **Alternative verworfen — spaCy (de_core_news_lg):** Deutlich niedrigerer F1 auf Deutsch (~85-87%). Schneller, aber Genauigkeit ist für Datenschutz wichtiger.
- **Alternative verworfen — GLiNER Multi PII:** Zero-Shot-Ansatz für 50+ PII-Typen, aber experimentell und weniger zuverlässig als flair für deutsche Standardentitäten. Als ergänzende Phase-2-Schicht vorgesehen.
- **Alternative verworfen — spaCy + Regex allein:** Ohne dediziertes deutsches NER-Modell zu viele False Negatives bei Namen in gesprochener Sprache.

## Konsequenzen

- **Grosses Modell:** ~2.2 GB Download, ~2.7 GB RAM während Anonymisierung (Peak ~5.2 GB mit Electron + OS).
- **Python-Sidecar:** flair läuft im gleichen Python-Sidecar wie pyannote — gemeinsame PyTorch-Dependency.
- **7 User-sichtbare Entitätstypen:** PERSON, ORT, DATUM, KONTAKT, ORGANISATION, MEDIZINISCH, SONSTIGES. Platzhalter-Format: `[PERSON 1]`, `[ORT 2]` etc.
- **Review-Pflicht:** Trotz ~92% F1 sind False Negatives möglich — der Review-Modus mit TipTap-Editor ist essentiell als Sicherheitsnetz.
- **Sperrliste als Ergänzung:** Therapeuten können wiederkehrende Patienten-/Ortsnamen in die Sperrliste eintragen, um False Negatives zu reduzieren. Bidirektionale Umlaut-Normalisierung, Longest-Match-First.
- **ORG-Lücke:** Institutionsnamen werden nur erkannt, wenn sie in der Sperrliste stehen oder manuell markiert werden.
