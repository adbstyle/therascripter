# Bewertungsanleitung für die Relevanzurteile

Wortlaut des Auftrags an die Bewerter-Agents (Claude), mit denen `qrels.jsonl` entstanden ist.
Wer Anfragen ergänzt, bewertet sie nach denselben Regeln. Herkunft und Ablauf: README.md.

## Erster Durchgang: erschöpfend pro Dokument

Jedem Agent waren Dokumente und die Anfragen zugewiesen, die zu diesen Dokumenten gehören.

```text
Du bist unabhängige:r Bewerter:in für ein Referenz-Set, das die Trefferqualität einer Suche in einer Psychotherapie-App misst. Du bewertest, ob einzelne Textstücke (Units) zu Suchanfragen passen. Du hast keine Ergebnisse der Suche gesehen und sollst auch keine erzeugen.

Arbeitsverzeichnis: Wurzel des Repos.
- Units eines Dokuments: `<venv>/bin/python scripts/search-spike.py units --doc <id> 2>/dev/null` (Venv siehe README) (JSONL: unit, speaker, text). Lies zusätzlich die ganze Quelldatei (tests/fixtures/search-reference/sessions/<id>.txt bzw. reports/<id>.txt) für den Zusammenhang: Wer spricht über wen, welche Person ist gemeint.
- Anfragen: tests/fixtures/search-reference/queries.jsonl (Felder id, type, text).

Bewertungsskala pro (Anfrage, Unit):
- 2 = Die Unit ist eine Stelle, die die Therapeut:in mit dieser Anfrage finden will: Sie beantwortet die Anfrage direkt oder enthält den gesuchten Sachverhalt zentral.
- 1 = Teilweise relevant: enthält einen Teil des Gesuchten, eine Vorstufe oder einen klaren Bezug, aber nicht den Kern.
- 0 = nicht relevant (nicht ausgeben).
Regeln:
- Anfragen vom Typ "klarname": Eine Unit ist relevant, wenn sie die genannte Person bzw. den genannten Ort meint, unabhängig von der Schreibform (Vorname, Nachname, Anrede, Genitiv, «Ihr Partner» nur wenn eindeutig dieselbe Person UND die übrige Anfrage passt). Besteht die Anfrage nur aus einem Namen, gilt jede Unit als 2, die diese Person ausdrücklich beim Namen nennt; Units, die sie nur umschreiben, als 1. Gleiche Namen verschiedener Personen («Sandra», «Corinne») zählen alle als relevant, denn die Anfrage nennt nur den Namen.
- Anfragen vom Typ "umgangssprache": Mundart der Anfrage verstehen und nach dem Inhalt bewerten.
- Anfragen vom Typ "negativ": normalerweise nichts relevant.
- Bewerte streng nach Inhalt, nicht nach Wortgleichheit. Kopfzeilen der Dateien sind keine Units.
- Prüfe JEDE Unit des Dokuments gegen JEDE zugewiesene Anfrage (erschöpfend).

Ausgabe: Schreibe die Datei, die dir unten genannt ist, als JSONL, eine Zeile pro Bewertung mit Note 1 oder 2: {"q": "q201", "unit": "a1:003.0", "grade": 2}. Prüfe am Ende mit python3: gültiges JSONL, jede unit-ID existiert in der Units-Ausgabe, jede q-ID existiert. Gib eine kurze Statistik zurück (Anzahl Bewertungen je Note, Anfragen ohne jede relevante Unit in deinen Dokumenten). Ändere keine anderen Dateien.
```

## Nachprüfung der Top-Treffer (Pooling)

Zusätzlich zur Anleitung oben erhielt jeder Agent einen Teil von
`results/pool-audit-<modell>.jsonl` (erzeugt mit `search-spike.py pool`):

```text
Abweichend davon bewertest du hier eine verblindete Nachprüfung: Die Datei <teil> enthält
JSONL mit {q, query, unit, text}. Bewerte JEDES Paar (Anfrage gegen Unit) mit 0, 1 oder 2.
Für den Zusammenhang (wer spricht, welche Person gemeint ist) darfst du die Quelldatei des
Dokuments lesen: unit-ID «a1:003.0» → sessions/a1.txt, «ra:…» → reports/ra.txt.

Schreibe nur Paare mit Note 1 oder 2 nach qrels-parts/<name>.jsonl im Format
{"q": "...", "unit": "...", "grade": 1}. Prüfe am Ende mit python3, dass die Datei gültiges
JSONL ist. Gib zurück: Anzahl Paare je Note. Ändere keine anderen Dateien.
```

Danach `search-spike.py merge-qrels` und `search-spike.py quality`.
