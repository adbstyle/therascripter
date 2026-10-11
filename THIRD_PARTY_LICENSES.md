# Drittlizenzen von TheraScript

**Freigabe durch den Projektverantwortlichen: ausstehend**

Diese Übersicht dokumentiert die Lizenzen aller Drittkomponenten, die TheraScript ausliefert, und aller Modelle, die TheraScript über das eigene Hosting (Cloudflare R2) weiterverteilt. Für jedes Modell hält sie fest, ob die Weitergabe über das eigene Hosting und der Einsatz in Therapiepraxen nach seiner Lizenz zulässig sind.

- **Stand:** 11. Oktober 2026
- **Erfasste Versionen:** v0.8.13 (zuletzt veröffentlichte Version) und der aktuelle Stand von `main` (Version 0.9.0). Die Laufzeit-Abhängigkeiten (npm-Pakete, Python-Sidecar, whisper.cpp, llama.cpp) sind in beiden Versionen identisch. Die beiden Versionen unterscheiden sich nur beim Zusammenfassungsmodell (v0.8.13: Gemma 3 4B, `main`: Gemma 4 E2B).
- **Nach 0.9.0:** Auf `main` zeigt die Über-Seite der App seit PR #184 Lizenzhinweise für die Hauptkomponenten und alle Modelle (`src/renderer/src/constants/acknowledgments.ts`). Die Vermerke «Derzeit nicht erfüllt» in dieser Übersicht beschreiben die veröffentlichten Versionen bis 0.9.0; sie sind mit dem nächsten Release neu zu prüfen.
- **Eigener Code:** Der Code von TheraScript steht unter der MIT-Lizenz, siehe [LICENSE](LICENSE).
- **Datengrundlage:** Die npm- und Python-Listen stammen aus dem gebauten App-Paket (`Therascript.app`, Version 0.9.0, gebaut am 11. Oktober 2026): Header von `app.asar`, `package.json` der ausgelieferten Pakete, `METADATA` und Lizenzdateien der `*.dist-info` im Python-Sidecar. Die vom Renderer-Bundle eingebundenen Pakete wurden mit dem Vite-Build der Renderer-Konfiguration ermittelt (Module mit gerendertem Code). Modell-Lizenzen stammen aus den Model Cards und der API von Hugging Face (abgerufen am 11. Oktober 2026). Die SHA-256-Werte der R2-Dateien wurden mit den LFS-Objekten auf Hugging Face abgeglichen, wo die Datei unverändert weitergegeben wird.

Begriffe in den Befunden:

- **zulässig:** Die Lizenz erlaubt den Vorgang ohne weitere Bedingungen.
- **zulässig unter Bedingungen:** Die Lizenz erlaubt den Vorgang, wenn die genannten Bedingungen erfüllt sind. Ob sie heute erfüllt sind, steht jeweils dabei.
- **unklar:** Die Lizenzlage lässt keine eindeutige Aussage zu.
- **nicht zulässig:** Die Lizenz erlaubt den Vorgang nicht.

## Inhalt

1. [Modelle](#modelle)
2. [Mitgelieferte Software](#mitgelieferte-software)
3. [Befunde](#befunde)

## Modelle

Die App lädt alle Modelle vom R2-CDN `https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev` (Katalog: `src/shared/model-catalog.ts`). Keine der R2-Dateien enthält einen Lizenztext, eine Model Card oder einen Urheberhinweis. Die Tarballs enthalten nur die Gewichte, Konfigurationen und Tokenizer-Dateien.

| Modell | R2-Datei | Lizenz | Weitergabe über R2 | Einsatz in Therapiepraxen | Versionen |
| --- | --- | --- | --- | --- | --- |
| Whisper Large V3 Turbo | `whisper-ggml-large-v3-turbo-q5_0.bin` | MIT | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| Whisper Large V3 Turbo (German) | `whisper-ggml-large-v3-turbo-german-q5_0.bin` | Apache-2.0 | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| Whisper Large V3 Turbo (Swiss-German) | `whisper-ggml-large-v3-turbo-swiss-q5_0.bin` | **CC-BY-NC-4.0** | zulässig unter Bedingungen | **nicht zulässig** | v0.8.13, main |
| pyannote speaker-diarization-3.1 | `pyannote-suite.tar.gz` | MIT | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| pyannote speaker-diarization-community-1 | `pyannote-suite.tar.gz` | CC-BY-4.0 | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| pyannote segmentation-3.0 | `pyannote-suite.tar.gz` | MIT | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| pyannote wespeaker-voxceleb-resnet34-LM | `pyannote-suite.tar.gz` | CC-BY-4.0 | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| flair/ner-german-large (fp16) | `flair-ner-german-large-v3.tar.gz` | **keine Lizenz angegeben** | **unklar** | **unklar** | v0.8.13, main |
| XLM-RoBERTa large (Tokenizer) | `flair-ner-german-large-v3.tar.gz` | MIT | zulässig unter Bedingungen | zulässig | v0.8.13, main |
| Gemma 3 4B Instruct (Q4_K_M) | `google_gemma-3-4b-it-Q4_K_M.gguf` | Gemma Terms of Use | zulässig unter Bedingungen | zulässig unter Bedingungen | v0.8.13 |
| Gemma 4 E2B Instruct (QAT Q4_0) | `gemma-4-E2B_q4_0-it.gguf` | Apache-2.0 | zulässig unter Bedingungen | zulässig | main |

Ältere NER-Artefakte (v1, v2) liegen laut `src/shared/model-catalog.ts` weiterhin auf R2, weil ältere App-Versionen sie laden. Sie enthalten dasselbe Modell in fp32 und unterliegen derselben Bewertung wie das v3-Artefakt.

### Whisper Large V3 Turbo (multilingual, ggml Q5_0)

- **Quelle:** [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), Datei `ggml-large-v3-turbo-q5_0.bin`. Die R2-Datei ist byte-identisch (SHA-256 `394221709cd5…`, gleich dem LFS-Objekt auf Hugging Face).
- **Lizenz:** MIT (`license: mit` auf [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) und auf [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo)). Laut [openai/whisper](https://github.com/openai/whisper#license) stehen Code und Gewichte unter MIT, Lizenztext: [LICENSE](https://github.com/openai/whisper/blob/main/LICENSE) («Copyright (c) 2022 OpenAI»).
- **Nutzungsbedingungen:** Keine über MIT hinaus. Die Model Card von OpenAI empfiehlt, Whisper nicht in Hochrisiko-Entscheidungskontexten einzusetzen und keine Aufnahmen ohne Einwilligung der Personen zu transkribieren. Diese Empfehlungen sind nicht Teil der Lizenz.
- **Zugangsbedingungen:** Keine (Repository nicht gated).
- **Basismodell:** [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) (MIT).
- **Konvertierung:** ggml-Konvertierung und Q5_0-Quantisierung durch das whisper.cpp-Projekt (MIT). TheraScript verändert die Datei nicht.
- **Geforderte Namensnennung:** MIT-Lizenztext mit dem Hinweis «Copyright (c) 2022 OpenAI» in allen Kopien. Das Repository ggerganov/whisper.cpp nennt keinen eigenen Copyright-Inhaber für die Konvertierung. **Derzeit nicht erfüllt:** Weder die R2-Datei noch die App enthalten den Lizenztext.
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (MIT-Lizenztext und Copyright-Hinweis beilegen).
- **Einsatz in Therapiepraxen:** zulässig (MIT enthält keine Einsatzbeschränkung).
- **Ausgeliefert in:** v0.8.13, main.

### Whisper Large V3 Turbo (German)

- **Quelle:** [primeline/whisper-large-v3-turbo-german](https://huggingface.co/primeline/whisper-large-v3-turbo-german), Revision `9e7012dad9` (heruntergeladen am 24. April 2026), von TheraScript mit `scripts/convert-hf-whisper.sh` konvertiert.
- **Lizenz:** Apache-2.0 (`license: apache-2.0` auf der Model Card).
- **Nutzungsbedingungen:** Keine über Apache-2.0 hinaus. Die Model Card schliesst die Haftung für fehlerhafte Ausgaben aus.
- **Zugangsbedingungen:** Keine (nicht gated).
- **Basismodell:** Laut Model Card [primeline/whisper-large-v3-german](https://huggingface.co/primeline/whisper-large-v3-german) (Apache-2.0), dieses basiert auf [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3) (Apache-2.0). Die Konfiguration (4 Decoder-Schichten) entspricht der Turbo-Architektur von [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) (MIT). Beide möglichen Basismodelle sind permissiv lizenziert. Trainingsdaten: [flozi00/asr-german-mixed](https://huggingface.co/datasets/flozi00/asr-german-mixed) (ohne Lizenzangabe, laut Beschreibung aus Common Voice und Multilingual LibriSpeech zusammengesetzt).
- **Konvertierung:** Durch TheraScript: ggml-Konvertierung mit whisper.cpp (`convert-h5-to-ggml.py`, gepatcht für bfloat16) und Q5_0-Quantisierung. Das ist eine Änderung im Sinne von Apache-2.0.
- **Geforderte Namensnennung:** Kopie der Apache-2.0-Lizenz (Abschnitt 4(a)) und ein deutlicher Hinweis, dass die Dateien verändert wurden (Abschnitt 4(b)). Kein NOTICE-File im Quell-Repository. Falls die Turbo-Gewichte von OpenAI stammen, zusätzlich der MIT-Hinweis «Copyright (c) 2022 OpenAI». **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (Apache-2.0 Abschnitt 4(a) und 4(b): Lizenzkopie beilegen, Konvertierung kennzeichnen).
- **Einsatz in Therapiepraxen:** zulässig (Apache-2.0 enthält keine Einsatzbeschränkung).
- **Ausgeliefert in:** v0.8.13, main.

### Whisper Large V3 Turbo (Swiss-German)

- **Quelle:** [Flurin17/whisper-large-v3-turbo-swiss-german](https://huggingface.co/Flurin17/whisper-large-v3-turbo-swiss-german), Revision `16a4f2c3f4` (heruntergeladen am 22. April 2026), von TheraScript mit `scripts/convert-hf-whisper.sh` konvertiert.
- **Lizenz:** **CC-BY-NC-4.0.** Die Model Card sagt: «This model is distributed under the Creative Commons Attribution-NonCommercial 4.0 license». Der Autor hat die Lizenz am 17. April 2026 von Apache-2.0 auf CC BY-NC 4.0 geändert (Commit «Update model license to CC BY-NC 4.0»). Die von TheraScript heruntergeladene Revision trägt bereits die NC-Lizenz. Das belegt die lokal erhaltene Model Card im Konvertierungsverzeichnis.
- **Nutzungsbedingungen:** Gemäss [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en), Abschnitt 2(a)(1), dürfen Vervielfältigung und Weitergabe nur zu nicht-kommerziellen Zwecken erfolgen. Abschnitt 1(i) definiert NonCommercial als «not primarily intended for or directed towards commercial advantage or monetary compensation». Laut Abschnitt 2(a)(5)(A) erhält jede Empfängerin ihre Lizenz direkt vom Lizenzgeber und ist selbst an diese Bedingungen gebunden.
- **Zugangsbedingungen:** Keine (nicht gated).
- **Basismodell:** [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) (MIT). Trainingsdaten laut Model Card privat (rund 301 Stunden).
- **Konvertierung:** Durch TheraScript: ggml-Konvertierung mit whisper.cpp und Q5_0-Quantisierung. Das ist ein bearbeitetes Material (Adapted Material) im Sinne der Lizenz.
- **Geforderte Namensnennung:** Nach CC BY-NC 4.0 Abschnitt 3(a)(1): Urheber (Flurin17), Hinweis auf die Lizenz mit Link, Hinweis auf den Gewährleistungsausschluss, Link auf das Modell und Kennzeichnung der Konvertierung. Zusätzlich für das Basismodell der MIT-Hinweis «Copyright (c) 2022 OpenAI». **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen. TheraScript selbst verfolgt mit der kostenlosen Weitergabe keinen kommerziellen Zweck. Bedingungen: Namensnennung und Kennzeichnung der Konvertierung nach Abschnitt 3(a), keine zusätzlichen Einschränkungen nach Abschnitt 2(a)(5)(B). Die Namensnennung fehlt heute. Die Weitergabe richtet sich ausdrücklich an Therapiepraxen, deren Nutzung die Lizenz nicht deckt (siehe nächster Punkt).
- **Einsatz in Therapiepraxen:** **nicht zulässig** (CC BY-NC 4.0 Abschnitt 2(a)(1) und 1(i)). Die Transkription von Sitzungen in einer entgeltlichen Praxis dient der Erbringung bezahlter Leistungen und ist damit nicht nicht-kommerziell. Ausgenommen wäre allenfalls ein Einsatz ohne Erwerbszweck. Die App bietet das Modell heute ohne Hinweis auf diese Einschränkung an.
- **Ausgeliefert in:** v0.8.13, main.

### pyannote speaker-diarization-3.1

- **Quelle:** [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1), Teil des Tarballs `pyannote-suite.tar.gz` (Inhalt laut `scripts/package-models.sh`: diese Pipeline, community-1, segmentation-3.0, wespeaker-voxceleb-resnet34-LM). Die Pipeline selbst besteht nur aus `config.yaml`.
- **Lizenz:** MIT (`license: mit`). Die Zugangsseite sagt, die Pipeline «uses MIT license and will always remain open-source».
- **Nutzungsbedingungen:** Keine über MIT hinaus.
- **Zugangsbedingungen:** Gated. Für den Zugriff auf Hugging Face muss man zustimmen, seine Kontaktdaten zu teilen, und die Bedingungen von segmentation-3.0 akzeptieren. Der vollständige Bedingungstext ist nur nach Login sichtbar und wurde nicht geprüft. Die öffentlich sichtbaren Bedingungen enthalten kein Weitergabeverbot. Die Weitergabe über R2 umgeht das Gate: Nutzerinnen von TheraScript erhalten das Modell, ohne ihre Kontaktdaten zu teilen.
- **Basismodell:** Keines. Die Pipeline referenziert segmentation-3.0 und wespeaker-voxceleb-resnet34-LM. Unter pyannote.audio 4.x lädt sie zusätzlich die PLDA-Dateien aus community-1.
- **Konvertierung:** Keine. Die Dateien liegen unverändert in der Hugging-Face-Cache-Struktur.
- **Geforderte Namensnennung:** MIT-Lizenztext mit Copyright-Hinweis. Das Modell-Repository enthält keine Lizenzdatei und keinen Copyright-Inhaber. Die Model Card bittet um Zitierung (Plaquet 2023, Bredin 2023), verlangt sie aber nicht. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (MIT-Lizenztext beilegen). Vorbehalt: Der vollständige Text der Zugangsbedingungen ist nicht geprüft.
- **Einsatz in Therapiepraxen:** zulässig (MIT enthält keine Einsatzbeschränkung).
- **Ausgeliefert in:** v0.8.13, main.

### pyannote speaker-diarization-community-1

- **Quelle:** [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), Revision `3533c8cf8e`, im Tarball `pyannote-suite.tar.gz` (Segmentierung, Embedding, PLDA, `config.yaml`).
- **Lizenz:** CC-BY-4.0 (`license: cc-by-4.0`). Die Zugangsseite sagt, die Pipeline «is released under the CC-BY-4.0 license».
- **Nutzungsbedingungen:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode.en), ohne Einschränkung des Einsatzzwecks.
- **Zugangsbedingungen:** Gated mit Zustimmung zur Weitergabe der Kontaktdaten. Der vollständige Bedingungstext ist nur nach Login sichtbar und wurde nicht geprüft. Die Weitergabe über R2 umgeht das Gate.
- **Basismodell:** Keine Angabe. Die Model Card zitiert die Komponenten: Segmentierung (Plaquet 2023), Embedding (WeSpeaker, Wang 2023) und Clustering (VBx, Landini 2022). Lizenzen und Trainingsdaten der einzelnen Komponenten nennt sie nicht.
- **Konvertierung:** Keine.
- **Geforderte Namensnennung:** Nach CC BY 4.0 Abschnitt 3(a)(1): Urheber (pyannote), Copyright-Hinweis falls vorhanden, Hinweis auf die Lizenz mit Link, Hinweis auf den Gewährleistungsausschluss, Link auf das Modell. Nach Abschnitt 3(a)(2) genügt ein Link auf eine Ressource mit diesen Angaben. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (Namensnennung nach CC BY 4.0 Abschnitt 3(a)). Vorbehalt: Der vollständige Text der Zugangsbedingungen ist nicht geprüft.
- **Einsatz in Therapiepraxen:** zulässig (CC BY 4.0 schränkt den Einsatzzweck nicht ein).
- **Ausgeliefert in:** v0.8.13, main. Die Datei wird auch dann benötigt, wenn die Pipeline 3.1 aktiv ist.

### pyannote segmentation-3.0

- **Quelle:** [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), im Tarball `pyannote-suite.tar.gz`.
- **Lizenz:** MIT (`license: mit`, «uses MIT license and will always remain open-source»).
- **Nutzungsbedingungen:** Keine über MIT hinaus.
- **Zugangsbedingungen:** Gated mit Zustimmung zur Weitergabe der Kontaktdaten. Laut Zugangsseite sendet pyannote gelegentlich E-Mails zu kostenpflichtigen Angeboten. Der vollständige Bedingungstext ist nur nach Login sichtbar und wurde nicht geprüft. Die Weitergabe über R2 umgeht das Gate.
- **Basismodell:** Keines. Laut Model Card trainiert von Séverin Baroudi auf AISHELL, AliMeeting, AMI, AVA-AVD, DIHARD, Ego4D, MSDWild, REPERE und VoxConverse. Die Lizenzen dieser Trainingskorpora wurden nicht einzeln geprüft. Der Lizenzgeber stellt das Modell unter MIT.
- **Konvertierung:** Keine.
- **Geforderte Namensnennung:** MIT-Lizenztext mit Copyright-Hinweis. Das Repository enthält keine Lizenzdatei und keinen Copyright-Inhaber. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (MIT-Lizenztext beilegen). Vorbehalt: Der vollständige Text der Zugangsbedingungen ist nicht geprüft.
- **Einsatz in Therapiepraxen:** zulässig (MIT enthält keine Einsatzbeschränkung).
- **Ausgeliefert in:** v0.8.13, main.

### pyannote wespeaker-voxceleb-resnet34-LM

- **Quelle:** [pyannote/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM), im Tarball `pyannote-suite.tar.gz`.
- **Lizenz:** CC-BY-4.0 (`license: cc-by-4.0`). Laut Model Card folgen die WeSpeaker-Modelle der Lizenz ihres Datensatzes. VoxCeleb steht laut Zitat der Model Card unter CC BY 4.0.
- **Nutzungsbedingungen:** CC BY 4.0, ohne Einschränkung des Einsatzzwecks.
- **Zugangsbedingungen:** Keine (nicht gated).
- **Basismodell:** Wrapper um das vortrainierte Modell `wespeaker-voxceleb-resnet34-LM` von [WeSpeaker](https://github.com/wenet-e2e/wespeaker) (Code: Apache-2.0), trainiert auf VoxCeleb.
- **Konvertierung:** Durch pyannote (Wrapper für pyannote.audio). TheraScript verändert die Datei nicht.
- **Geforderte Namensnennung:** Nach CC BY 4.0 Abschnitt 3(a)(1): Urheber (WeSpeaker bzw. pyannote), Hinweis auf die Lizenz mit Link, Hinweis auf den Gewährleistungsausschluss, Link auf das Modell. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (Namensnennung nach CC BY 4.0 Abschnitt 3(a)).
- **Einsatz in Therapiepraxen:** zulässig (CC BY 4.0 schränkt den Einsatzzweck nicht ein).
- **Ausgeliefert in:** v0.8.13, main.

### flair/ner-german-large (NER-Artefakt v3, fp16)

- **Quelle:** [flair/ner-german-large](https://huggingface.co/flair/ner-german-large), Revision `4b459fadcf`. R2-Datei `flair-ner-german-large-v3.tar.gz` (Inhalt laut `scripts/package-models.sh` und `scripts/convert-ner-fp16.py`: der nach fp16 konvertierte Checkpoint plus der XLM-RoBERTa-Tokenizer unter `hf/`).
- **Lizenz:** **Keine Angabe.** Die Model Card hat kein `license`-Feld, und das Repository enthält keine Lizenzdatei (nur `README.md`, `loss.tsv`, `training.log`, Gewichte). Die MIT-Lizenz der [flair-Bibliothek](https://github.com/flairNLP/flair/blob/master/LICENSE) («Copyright © 2018 Zalando SE») gilt für die Software. Dass sie auch die vortrainierten Gewichte erfasst, ist nirgends erklärt.
- **Nutzungsbedingungen:** Keine angegeben. Die Model Card bittet um Zitierung des FLERT-Papers (Schweter und Akbik 2020).
- **Zugangsbedingungen:** Keine (nicht gated).
- **Basismodell:** [xlm-roberta-large](https://huggingface.co/FacebookAI/xlm-roberta-large) (MIT), feinabgestimmt auf CoNLL-03 German (revidierte Fassung). Die Texte von CoNLL-03 German stammen laut [Tjong Kim Sang und De Meulder 2003](https://arxiv.org/abs/cs/0306050) aus der Frankfurter Rundschau im ECI Multilingual Text Corpus. Für dieses Korpus gilt laut [ECI-Beschreibung](https://www.coverpages.org/eciHome.html) eine Lizenzvereinbarung, die die Nutzung auf Forschungszwecke beschränkt, und ein Weitergabeverbot für die Daten («You should not redistribute the data that you get from us, nor should you sell it»). Ob diese Beschränkung auch für ein darauf trainiertes Modell gilt, ist nicht geklärt.
- **Konvertierung:** Durch TheraScript: Neuspeicherung mit aktueller flair-Version und Konvertierung nach fp16 (`scripts/convert-ner-fp16.py`). Die Datei behält den Namen des fp32-Original-Blobs.
- **Geforderte Namensnennung:** Mangels Lizenz keine festgelegt. Mindestens angemessen wären Urheber (flair, Humboldt-Universität zu Berlin, Schweter und Akbik), Link zur Model Card und Hinweis auf die Konvertierung. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** **unklar.** Ohne Lizenz hat TheraScript keine ausdrückliche Erlaubnis zur Weitergabe, und zwar weder des Originals noch der veränderten fp16-Fassung. Hinzu kommt die Forschungsbeschränkung der Trainingsdaten. Eine schriftliche Erlaubnis der flair-Maintainer würde die Frage klären.
- **Einsatz in Therapiepraxen:** **unklar.** Es gibt keine Lizenz, die den Einsatz erlaubt oder beschränkt. Die Trainingsdaten sind nur für Forschungszwecke lizenziert, ob das auf das Modell durchschlägt, ist offen.
- **Ausgeliefert in:** v0.8.13, main. Die Artefakte v1 und v2 enthalten dasselbe Modell in fp32.

### XLM-RoBERTa large (Tokenizer im NER-Artefakt)

- **Quelle:** [FacebookAI/xlm-roberta-large](https://huggingface.co/FacebookAI/xlm-roberta-large). Im NER-Tarball liegen nur `config.json`, `sentencepiece.bpe.model`, `tokenizer.json` und `tokenizer_config.json` unter `ner/hf/hub/models--xlm-roberta-large/`.
- **Lizenz:** MIT (`license:mit`). Das Hugging-Face-Repository enthält keine Lizenzdatei. Das ursprüngliche Projekt [fairseq](https://github.com/facebookresearch/fairseq/blob/main/LICENSE) nennt «Copyright (c) Facebook, Inc. and its affiliates».
- **Nutzungsbedingungen:** Keine über MIT hinaus.
- **Zugangsbedingungen:** Keine.
- **Basismodell:** Keines.
- **Konvertierung:** Keine.
- **Geforderte Namensnennung:** MIT-Lizenztext mit Copyright-Hinweis. **Derzeit nicht erfüllt.**
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (MIT-Lizenztext beilegen).
- **Einsatz in Therapiepraxen:** zulässig.
- **Ausgeliefert in:** v0.8.13, main.

### Gemma 3 4B Instruct (Q4_K_M, GGUF)

- **Quelle:** [bartowski/google_gemma-3-4b-it-GGUF](https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF), Datei `google_gemma-3-4b-it-Q4_K_M.gguf`. Die R2-Datei ist byte-identisch (SHA-256 `4996030242…`, gleich dem LFS-Objekt).
- **Lizenz:** [Gemma Terms of Use](https://ai.google.dev/gemma/terms) (zuletzt geändert am 1. April 2026). Gemma 3 ist im Anhang der Terms aufgeführt. Nach Abschnitt 1.1(c) gelten die Terms für Gemma «regardless of the source that you obtained it from», also auch für die Kopie von bartowski. Die Model Card von bartowski hat kein Lizenzfeld.
- **Nutzungsbedingungen:** Abschnitt 3.2 verbietet Nutzungen, die gegen die [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) oder geltendes Recht verstossen. Für Therapiepraxen sind folgende Klauseln der Policy einschlägig:
  - 2.5.8 verbietet das Erheben, Verarbeiten oder Ableiten sensibler Personendaten ohne die gesetzlich erforderlichen Rechte und Einwilligungen.
  - 3.4 verbietet automatisierte Entscheidungen in Bereichen, die Rechte oder Wohlergehen betreffen, darunter das Gesundheitswesen.
  - 2.2 und 3.6 verbieten die unbefugte Ausübung eines Berufs.

  Nach Abschnitt 3.2 darf Google die Nutzung bei vermuteten Verstössen einschränken («remotely or otherwise»).
- **Zugangsbedingungen:** Das Google-Original [google/gemma-3-4b-it](https://huggingface.co/google/gemma-3-4b-it) ist gated (manuelle Zustimmung zu den Gemma Terms). Die Kopie von bartowski ist laut Hugging-Face-API nicht gated.
- **Basismodell:** [google/gemma-3-4b-it](https://huggingface.co/google/gemma-3-4b-it) (Gemma Terms of Use).
- **Konvertierung:** GGUF-Quantisierung Q4_K_M mit imatrix durch bartowski (llama.cpp b4877). Das ist ein «Model Derivative» im Sinne von Abschnitt 1.1(e). TheraScript verändert die Datei nicht.
- **Geforderte Namensnennung:** Abschnitt 3.1 verlangt bei jeder Weitergabe vier Dinge:
  1. Die Nutzungsbeschränkungen aus 3.2 sind als durchsetzbare Bestimmung in jede Vereinbarung aufzunehmen, die die Nutzung regelt, und den Empfängerinnen mitzuteilen.
  2. Den Empfängerinnen ist eine Kopie der Terms zu übergeben.
  3. Veränderte Dateien sind zu kennzeichnen.
  4. Der Weitergabe ist eine «Notice»-Textdatei beizulegen mit dem Satz «Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms».

  **Derzeit nicht erfüllt.** v0.8.13 zeigt keinen Gemma-Hinweis, und auf R2 liegt keine Notice-Datei.
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (Gemma Terms Abschnitt 3.1 Punkte 1 bis 4, heute keiner davon erfüllt).
- **Einsatz in Therapiepraxen:** zulässig unter Bedingungen. Der Einsatz ist erlaubt, solange er die Prohibited Use Policy einhält. Insbesondere braucht die Verarbeitung von Gesundheitsdaten die erforderlichen Rechte und Einwilligungen (2.5.8), und die Zusammenfassung darf keine automatisierte Entscheidung sein (3.4). TheraScript erzeugt nur Zusammenfassungen, die die Fachperson prüft, und erinnert vor der Aufnahme an die Einwilligung.
- **Ausgeliefert in:** v0.8.13 und früher. In `main` ist das Modell aus dem Katalog entfernt (`RETIRED_MODELS`) und wird beim App-Start gelöscht. Auf R2 bleibt die Datei für v0.8.13 erreichbar.

### Gemma 4 E2B Instruct (QAT Q4_0, GGUF)

- **Quelle:** [google/gemma-4-E2B-it-qat-q4_0-gguf](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf), Datei `gemma-4-E2B_q4_0-it.gguf`. Die R2-Datei ist byte-identisch (SHA-256 `fa401b55b0…`, gleich dem LFS-Objekt).
- **Lizenz:** Apache-2.0 (`license: apache-2.0`, `license_link: https://ai.google.dev/gemma/docs/gemma_4_license`). Die Gemma Terms of Use gelten laut Google nur für die Modelle in ihrem Anhang. Für Gemma 4 verweisen sie auf die eigene Lizenz («For Gemma 4 terms, see the Gemma 4 license»), und diese ist der [Apache-2.0-Text](https://ai.google.dev/gemma/apache_2).
- **Nutzungsbedingungen:** Keine über Apache-2.0 hinaus. Die Model Card enthält Hinweise zu Einsatzzweck und Grenzen, aber keine Verbote.
- **Zugangsbedingungen:** Keine (nicht gated).
- **Basismodell:** [google/gemma-4-E2B-it-qat-q4_0-unquantized](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-unquantized) (Google, Apache-2.0).
- **Konvertierung:** Durch Google selbst (offizielles QAT-GGUF). TheraScript verändert die Datei nicht.
- **Geforderte Namensnennung:** Kopie der Apache-2.0-Lizenz (Abschnitt 4(a)). Das Repository enthält kein NOTICE-File und keine Copyright-Zeile. **In `main` erfüllt:** Die Seite «Über» der App zeigt das Modell mit «© Google LLC», «Apache License 2.0» und dem vollständigen Lizenztext (`src/renderer/src/components/AboutPage.tsx`). Die R2-Datei selbst liegt ohne Lizenztext.
- **Weitergabe über eigenes Hosting:** zulässig unter Bedingungen (Apache-2.0 Abschnitt 4(a): Lizenzkopie, in `main` erfüllt).
- **Einsatz in Therapiepraxen:** zulässig (Apache-2.0 enthält keine Einsatzbeschränkung, und die Gemma Prohibited Use Policy gilt nicht für Gemma 4).
- **Ausgeliefert in:** main (ab Version 0.9.0).

## Mitgelieferte Software

### Inhalt des App-Pakets

Laut `electron-builder.yml` enthält `Therascript.app` Folgendes:

- **Electron-Laufzeit:** Electron Framework, Squirrel, Mantle, ReactiveObjC.
- **`app.asar`:** gebündelter Code (`out/`) und die Produktions-`node_modules`.
- **`whisper/`:** whisper.cpp mit libggml.
- **`llama/`:** llama.cpp mit ggml-Plugins, OpenSSL und libomp.
- **`bin/vision-ocr`:** eigener Swift-Code.
- **`icons/`:** eigene Icons.
- **`ml_sidecar/`:** Python-Standalone und eigene Skripte.

Das Paket enthält keine Sammeldatei mit Lizenzhinweisen. Ein Teil der Lizenzdateien liegt verstreut in den Paketen selbst, nämlich in den `node_modules` und den Python-`dist-info`-Ordnern. Wo das nicht reicht, steht es unter «Namensnennung» und in den [Befunden](#befunde).

### Hauptkomponenten

| Komponente | Version | Lizenz | Quelle | Geforderte Namensnennung | Im App-Paket enthalten? |
| --- | --- | --- | --- | --- | --- |
| Electron | 34.5.8 | MIT | [LICENSE](https://github.com/electron/electron/blob/main/LICENSE) | «Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.» plus MIT-Text | nein |
| Chromium (in Electron) | 132.0.6834.210 | BSD-3-Clause plus zahlreiche Drittlizenzen | [LICENSE](https://github.com/chromium/chromium/blob/main/LICENSE), `LICENSES.chromium.html` aus der Electron-Distribution (392 Komponenten) | «Copyright 2015 The Chromium Authors» und alle Hinweise aus `LICENSES.chromium.html` | nein (die Datei liegt in `node_modules/electron/dist/`, wird aber nicht ins App-Paket kopiert) |
| Node.js (in Electron) | 20.19.1 | MIT plus Drittlizenzen | [LICENSE](https://github.com/nodejs/node/blob/main/LICENSE) | «Copyright Node.js contributors» plus MIT-Text | nein |
| FFmpeg (`libffmpeg.dylib` in Electron) | Chromium-Build | LGPL-2.1-or-later ([FFmpeg Legal](https://ffmpeg.org/legal.html)) | Electron baut FFmpeg laut [`build/args/release.gn`](https://github.com/electron/electron/blob/v34.5.8/build/args/release.gn) als dynamische Bibliothek mit proprietären Codecs (`proprietary_codecs = true`, `ffmpeg_branding = "Chrome"` in `all.gn`) | LGPL-Lizenztext, Hinweis auf FFmpeg, Zugang zum Quellcode | nein |
| Squirrel.Mac | Electron-Distribution | MIT | [LICENSE](https://github.com/Squirrel/Squirrel.Mac/blob/main/LICENSE) | «Copyright (c) 2013 GitHub» | nein |
| Mantle | Electron-Distribution | MIT | [LICENSE.md](https://github.com/Mantle/Mantle/blob/master/LICENSE.md) | «Copyright (c) GitHub, Inc.» | nein |
| ReactiveObjC | Electron-Distribution | MIT | [LICENSE.md](https://github.com/ReactiveCocoa/ReactiveObjC/blob/master/LICENSE.md) | MIT-Text | nein |
| whisper.cpp (`whisper-cli`, `libwhisper`) | 1.8.3 (Homebrew) | MIT | [LICENSE](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE) | «Copyright (c) 2023-2026 The ggml authors» | nein |
| ggml (im whisper-Bundle) | 0.9.5 | MIT | [LICENSE](https://github.com/ggml-org/ggml/blob/master/LICENSE) | «Copyright (c) 2023-2026 The ggml authors» | nein |
| miniaudio, stb_vorbis (in `whisper-cli` kompiliert, laut `examples/common-whisper.cpp` v1.8.3) | vendored | Public Domain oder MIT-0 | Dateiköpfe im whisper.cpp-Repository | keine | nicht nötig |
| llama.cpp (`llama-cli`, `libllama`, `libllama-common`, `libmtmd`) | b9200 (Homebrew) | MIT | [LICENSE](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | «Copyright (c) 2023-2026 The ggml authors» | nein |
| ggml (im llama-Bundle, inklusive Backend-Plugins) | 0.12.0 | MIT | [LICENSE](https://github.com/ggml-org/ggml/blob/master/LICENSE) | wie oben | nein |
| cpp-httplib (in `libllama-common`) | vendored in b9200 | MIT | [LICENSE](https://github.com/ggml-org/llama.cpp/blob/b9200/vendor/cpp-httplib/LICENSE) | «Copyright (c) 2017 yhirose» | nein |
| nlohmann/json (in `libllama-common`) | vendored in b9200 | MIT | [licenses/LICENSE-jsonhpp](https://github.com/ggml-org/llama.cpp/tree/b9200/licenses) | MIT-Text von nlohmann/json | nein |
| miniaudio, stb_image, subprocess.h (llama.cpp vendor) | vendored in b9200 | Public Domain, MIT-0 oder Unlicense | Dateiköpfe in `vendor/` | keine | nicht nötig |
| OpenSSL (`libssl.3`, `libcrypto.3` im llama-Bundle) | 3.6.2 (Build 0.9.0) | Apache-2.0 | [LICENSE.txt](https://github.com/openssl/openssl/blob/master/LICENSE.txt) | Kopie der Apache-2.0-Lizenz (Abschnitt 4(a)) | nein |
| LLVM OpenMP (`libomp.dylib` im llama-Bundle, zusätzlich in torch und scikit-learn) | aus Homebrew bzw. Wheels | Apache-2.0 WITH LLVM-exception | [LICENSE.TXT](https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT) | Kopie der Lizenz | nein (in den Python-Wheels teilweise über deren Lizenzdateien) |
| vision-ocr | eigener Code | MIT (TheraScript) | `swift_cli/` | keine Drittkomponenten, nur Apple-Systemframeworks | entfällt |
| python-build-standalone (CPython-Distribution, via uv) | Release 20260114 | MPL-2.0 (Build-Skripte) | [LICENSE](https://github.com/astral-sh/python-build-standalone/blob/main/LICENSE) | keine für das Produkt | entfällt |
| CPython | 3.12.12 | PSF-2.0 | `lib/python3.12/LICENSE.txt` (im Paket enthalten) | PSF-Lizenztext | ja |
| Statisch in CPython gelinkt: OpenSSL 3.5.4 | 3.5.4 | Apache-2.0 | siehe oben | Kopie der Apache-2.0-Lizenz | nein |
| Statisch in CPython gelinkt: SQLite | 3.50.4 | Public Domain ([sqlite.org](https://www.sqlite.org/copyright.html)) | | keine | nicht nötig |
| Statisch in CPython gelinkt: libffi | | MIT ([LICENSE](https://github.com/libffi/libffi/blob/master/LICENSE)) | | «Copyright (c) 1996-… Anthony Green, Red Hat, Inc and others» | nein |
| Statisch in CPython gelinkt: libmpdec (mpdecimal) | | BSD-artig ([bytereef.org](https://www.bytereef.org/mpdecimal/)) | | Copyright-Hinweis | nein |
| Statisch in CPython gelinkt: bzip2 | 1.0.8 | bzip2-1.0.6 ([LICENSE](https://sourceware.org/git/?p=bzip2.git;a=blob_plain;f=LICENSE;hb=HEAD)) | | «copyright (C) 1996-2019 Julian R Seward» | nein |
| Statisch in CPython gelinkt: liblzma (XZ Utils) | 5.8.1 | 0BSD ([COPYING](https://github.com/tukaani-project/xz/blob/v5.8.1/COPYING)) | | keine | nicht nötig |
| Statisch in CPython gelinkt: Expat | 2.6.3 | MIT ([libexpat](https://github.com/libexpat/libexpat)) | | MIT-Text | nein |
| Tcl/Tk (`libtcl9.0`, `libtcl9tk9.0`) | 9.0.3 | TCL ([license.terms](https://github.com/tcltk/tcl/blob/main/license.terms)) | `lib/tk9.0/demos/license.terms` enthalten | Lizenzhinweis | teilweise |
| PyTorch (`torch`) | 2.10.0 | BSD-3-Clause, plus NOTICE mit Drittkomponenten | `torch-2.10.0.dist-info/licenses/LICENSE` und `NOTICE` | Copyright-Hinweise aus LICENSE und NOTICE | ja |
| torchaudio | 2.10.0 | BSD-2-Clause | dist-info | «Copyright (c) 2017 Facebook Inc. (Soumith Chintala)» | ja |
| torchcodec | 0.10.0 | BSD-3-Clause | dist-info | Copyright-Hinweis | ja |
| pyannote.audio (plus core, database, metrics, pipeline, pyannoteai-sdk) | 4.0.4 | MIT | dist-info | «Copyright (c) 2020 CNRS» (je Paket eigene Zeile) | ja |
| flair | 0.15.1 | MIT | [LICENSE](https://github.com/flairNLP/flair/blob/master/LICENSE) | «Copyright © 2018 Zalando SE» | ja (dist-info) |
| transformers | 4.57.6 | Apache-2.0 | dist-info | Kopie der Apache-2.0-Lizenz | ja |
| soundfile mit libsndfile (`_soundfile_data/libsndfile_arm64.dylib`) | 0.13.1 / libsndfile 1.2.2 | soundfile BSD-3-Clause, libsndfile **LGPL-2.1** | `_soundfile_data/COPYING` (LGPL-2.1, im Paket enthalten) | LGPL-Text, Zugang zum Quellcode | Lizenztext ja, Quellcode-Angebot nein |
| Statisch in libsndfile gelinkt ([libsndfile-binaries](https://github.com/bastibe/libsndfile-binaries)) | | FLAC, Ogg Vorbis, Opus: BSD-3-Clause. mpg123: **LGPL-2.1**. LAME: **LGPL-2.0** | Angaben aus der README von libsndfile-binaries | Lizenztexte | nein |
| SciPy mit gebündelten Laufzeitbibliotheken (`scipy/.dylibs`) | 1.17.1 | SciPy BSD-3-Clause. libgfortran und libgcc_s: **GPL-3.0-or-later WITH GCC-exception-3.1**. libquadmath: **LGPL-2.1-or-later** | `scipy-1.17.1.dist-info/LICENSE.txt` (enthält die Texte der gebündelten Bibliotheken) | Lizenztexte | ja |
| Pillow mit gebündelten Bibliotheken (`PIL/.dylibs`) | 12.1.1 | Pillow MIT-CMU. Gebündelt: FreeType (FTL oder GPL-2.0), HarfBuzz (Old MIT), libjpeg-turbo, libpng, libtiff, libwebp, OpenJPEG, lcms2, libavif, Brotli, liblzma, zlib-ng, libxcb, libXau (alle permissiv) | `pillow-12.1.1.dist-info/licenses/LICENSE` (enthält alle Texte) | Lizenztexte. Die FreeType-Lizenz verlangt zusätzlich eine Nennung in der Dokumentation | Lizenzdatei ja |
| setuptools-Reste (`_distutils_hack`, `distutils-precedence.pth`) | | MIT | Überbleibsel nach dem Pruning in `scripts/build-sidecar.sh`, ohne dist-info | MIT-Text | nein |

### npm-Pakete

Die Tabelle umfasst 102 Pakete. Davon sind 61 Produktions-Pakete in `app.asar/node_modules`, die electron-builder aus dem Abhängigkeitsgraph von `dependencies` sammelt. Ihre Lizenzdateien liegen jeweils im Paketordner bei. Die übrigen 41 Pakete sind vom Vite-Build in das Renderer-Bundle `out/renderer/assets/index-*.js` eingebunden. Bei ihnen ist nach dem Bündeln kein Lizenztext mehr vorhanden. Erhalten bleiben nur die Kurzkommentare `@license React` und `@license lucide-react v1.11.0 - ISC`.

Die Bundles für Main- und Preload-Prozess enthalten ausserdem `electron-store` (mit seinen Abhängigkeiten), `@electron-toolkit/preload` und `zod`. Diese Pakete liegen zusätzlich mit ihrer Lizenzdatei in `node_modules`. `react`, `react-dom`, `scheduler` und `use-sync-external-store` kommen im Vite-Modulgraph doppelt vor (CJS- und ESM-Einstieg) und sind hier je einmal aufgeführt.

Die Lizenzen stammen aus dem Feld `license` der jeweiligen `package.json`.

| Paket | Version | Lizenz | Auslieferung |
| --- | --- | --- | --- |
| @electron-toolkit/preload | 3.0.2 | MIT | node_modules |
| @tiptap/core | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-blockquote | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-bold | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-code | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-code-block | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-document | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-hard-break | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-heading | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-horizontal-rule | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-italic | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-link | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-list | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-paragraph | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-strike | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-text | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extension-underline | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/extensions | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/pm | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/react | 3.19.0 | MIT | Renderer-Bundle |
| @tiptap/starter-kit | 3.19.0 | MIT | Renderer-Bundle |
| ajv | 8.17.1 | MIT | node_modules |
| ajv-formats | 3.0.1 | MIT | node_modules |
| atomically | 2.1.1 | MIT | node_modules |
| base64-js | 1.5.1 | MIT | node_modules |
| bindings | 1.5.0 | MIT | node_modules |
| bl | 4.1.0 | MIT | node_modules |
| buffer | 5.7.1 | MIT | node_modules |
| chownr | 1.1.4 | ISC | node_modules |
| conf | 15.1.0 | MIT | node_modules |
| debounce-fn | 6.0.0 | MIT | node_modules |
| decompress-response | 6.0.0 | MIT | node_modules |
| deep-extend | 0.6.0 | MIT | node_modules |
| detect-libc | 2.1.2 | Apache-2.0 | node_modules |
| dot-prop | 10.1.0 | MIT | node_modules |
| electron-store | 11.0.2 | MIT | node_modules |
| end-of-stream | 1.4.5 | MIT | node_modules |
| env-paths | 3.0.0 | MIT | node_modules |
| expand-template | 2.0.3 | (MIT OR WTFPL) | node_modules |
| fast-deep-equal | 3.1.3 | MIT | node_modules |
| fast-equals | 5.4.0 | MIT | Renderer-Bundle |
| fast-uri | 3.1.0 | BSD-3-Clause | node_modules |
| file-uri-to-path | 1.0.0 | MIT | node_modules |
| fs-constants | 1.0.0 | MIT | node_modules |
| github-from-package | 0.0.0 | MIT | node_modules |
| ieee754 | 1.2.1 | BSD-3-Clause | node_modules |
| inherits | 2.0.4 | ISC | node_modules |
| ini | 1.3.8 | ISC | node_modules |
| json-schema-traverse | 1.0.0 | MIT | node_modules |
| json-schema-typed | 8.0.2 | BSD-2-Clause | node_modules |
| linkifyjs | 4.3.2 | MIT | Renderer-Bundle |
| lucide-react | 1.11.0 | ISC | Renderer-Bundle |
| mimic-function | 5.0.1 | MIT | node_modules |
| mimic-response | 3.1.0 | MIT | node_modules |
| minimist | 1.2.8 | MIT | node_modules |
| mkdirp-classic | 0.5.3 | MIT | node_modules |
| napi-build-utils | 2.0.0 | MIT | node_modules |
| node-abi | 3.87.0 | MIT | node_modules |
| node-readable-to-web-readable-stream | 0.4.2 | MIT | node_modules |
| once | 1.4.0 | ISC | node_modules |
| orderedmap | 2.1.1 | MIT | Renderer-Bundle |
| pdfjs-dist | 5.4.624 | Apache-2.0 | node_modules |
| prebuild-install | 7.1.3 | MIT | node_modules |
| prosemirror-commands | 1.7.1 | MIT | Renderer-Bundle |
| prosemirror-dropcursor | 1.8.2 | MIT | Renderer-Bundle |
| prosemirror-gapcursor | 1.4.0 | MIT | Renderer-Bundle |
| prosemirror-history | 1.5.0 | MIT | Renderer-Bundle |
| prosemirror-keymap | 1.2.3 | MIT | Renderer-Bundle |
| prosemirror-model | 1.25.4 | MIT | Renderer-Bundle |
| prosemirror-schema-list | 1.5.1 | MIT | Renderer-Bundle |
| prosemirror-state | 1.4.4 | MIT | Renderer-Bundle |
| prosemirror-transform | 1.11.0 | MIT | Renderer-Bundle |
| prosemirror-view | 1.41.6 | MIT | Renderer-Bundle |
| pump | 3.0.3 | MIT | node_modules |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | node_modules |
| react | 19.2.4 | MIT | Renderer-Bundle |
| react-dom | 19.2.4 | MIT | Renderer-Bundle |
| readable-stream | 3.6.2 | MIT | node_modules |
| require-from-string | 2.0.2 | MIT | node_modules |
| rope-sequence | 1.3.4 | MIT | Renderer-Bundle |
| safe-buffer | 5.2.1 | MIT | node_modules |
| scheduler | 0.27.0 | MIT | Renderer-Bundle |
| semver | 7.7.4 | ISC | node_modules |
| simple-concat | 1.0.1 | MIT | node_modules |
| simple-get | 4.0.1 | MIT | node_modules |
| string_decoder | 1.3.0 | MIT | node_modules |
| strip-json-comments | 2.0.1 | MIT | node_modules |
| stubborn-fs | 2.0.0 | MIT | node_modules |
| stubborn-utils | 1.0.2 | MIT | node_modules |
| tagged-tag | 1.0.0 | MIT | node_modules |
| tailwindcss | 4.1.18 | MIT | Renderer-Bundle |
| tar-fs | 2.1.4 | MIT | node_modules |
| tar-stream | 2.2.0 | MIT | node_modules |
| tunnel-agent | 0.6.0 | Apache-2.0 | node_modules |
| type-fest | 5.4.4 | (MIT OR CC0-1.0) | node_modules |
| uint8array-extras | 1.5.0 | MIT | node_modules |
| use-sync-external-store | 1.6.0 | MIT | Renderer-Bundle |
| util-deprecate | 1.0.2 | MIT | node_modules |
| w3c-keyname | 2.2.8 | MIT | Renderer-Bundle |
| when-exit | 2.1.5 | MIT | node_modules |
| wrappy | 1.0.2 | ISC | node_modules |
| zod | 4.3.6 | MIT | node_modules |

Lizenzen im Überblick: MIT 86, ISC 7, BSD-3-Clause 2, Apache-2.0 3, BSD-2-Clause 1, `(MIT OR WTFPL)` 1, `(BSD-2-Clause OR MIT OR Apache-2.0)` 1, `(MIT OR CC0-1.0)` 1. Kein npm-Paket steht unter einer Copyleft-Lizenz.

Folgende ausgelieferte Pakete enthalten Unterkomponenten mit eigener Lizenz:

- **pdfjs-dist:** Apache-2.0. Enthält zusätzlich die CMaps von Adobe (BSD-artig, «Copyright 1990-2009 Adobe Systems Incorporated»), ICC-Profile (CC0-1.0), Foxit-Standardschriften (BSD-artig, PDFium Authors), Liberation-Schriften (OFL-1.1) sowie WASM-Module von OpenJPEG (BSD-2-Clause), JBIG2 (PDFium, BSD-artig) und qcms (MIT). Alle Lizenzdateien liegen im Paket bei.
- **better-sqlite3:** MIT. Kompiliert SQLite 3.51.2 (Public Domain) ein.
- **lucide-react:** ISC. Ein Teil der Icons stammt aus Feather (MIT). Beide Hinweise stehen in der Lizenzdatei des Pakets, die aber nicht ausgeliefert wird, weil das Paket gebündelt ist.

### Python-Pakete

Die Tabelle umfasst 120 Pakete. Sie stammen aus den `*.dist-info`-Ordnern in `ml_sidecar/standalone/lib/python3.12/site-packages`. Das ist der Stand nach dem Pruning in `scripts/build-sidecar.sh`: grpcio, fonttools, SQLAlchemy, pip, setuptools und wheel sind entfernt. Die Abhängigkeiten stammen aus `python_sidecar/requirements.txt` und `requirements-ner.txt` inklusive transitiver Abhängigkeiten.

Der Build vom 27. Februar 2026 wird unverändert für v0.8.13 und `main` verwendet. Die Anforderungen sind seit v0.8.13 unverändert, ein Abgleich mit dem DMG von v0.8.13 erfolgte nicht.

Die Spalte «Quelle» zeigt, woher die Lizenzangabe stammt:

- **Metadaten:** `License-Expression`, `License` oder Classifier in `METADATA`.
- **LICENSE-Datei:** Lizenzdatei im dist-info-Ordner, weil die Metadaten fehlen oder unvollständig sind.
- **Repository:** Lizenz aus dem Quell-Repository, weil das Paket gar keine Lizenzangabe enthält.

| Paket | Version | Lizenz | Quelle |
| --- | --- | --- | --- |
| accelerate | 1.12.0 | Apache-2.0 | Metadaten |
| aiohappyeyeballs | 2.6.1 | PSF-2.0 | Metadaten |
| aiohttp | 3.13.3 | Apache-2.0 AND MIT | Metadaten |
| aiosignal | 1.4.0 | Apache-2.0 | Metadaten |
| alembic | 1.18.4 | MIT | Metadaten |
| asteroid-filterbanks | 0.4.0 | MIT | Metadaten |
| attrs | 25.4.0 | MIT | Metadaten |
| beautifulsoup4 | 4.14.3 | MIT | Metadaten |
| bioc | 2.1 | MIT | LICENSE-Datei (dist-info) |
| boto3 | 1.42.58 | Apache-2.0 | Metadaten |
| botocore | 1.42.58 | Apache-2.0 | Metadaten |
| certifi | 2026.2.25 | MPL-2.0 | Metadaten |
| cffi | 2.0.0 | MIT | Metadaten |
| charset-normalizer | 3.4.4 | MIT | Metadaten |
| colorlog | 6.10.1 | MIT | Metadaten |
| conllu | 4.5.3 | MIT | Metadaten |
| contourpy | 1.3.3 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| cycler | 0.12.1 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| Deprecated | 1.3.1 | MIT | Metadaten |
| docopt | 0.6.2 | MIT | Metadaten |
| einops | 0.8.2 | MIT | Metadaten |
| filelock | 3.24.3 | MIT | Metadaten |
| flair | 0.15.1 | MIT | Metadaten |
| frozenlist | 1.8.0 | Apache-2.0 | Metadaten |
| fsspec | 2026.2.0 | BSD-3-Clause | Metadaten |
| ftfy | 6.3.1 | Apache-2.0 | Metadaten |
| gdown | 5.2.1 | MIT | Metadaten |
| googleapis-common-protos | 1.72.0 | Apache-2.0 | Metadaten |
| hf-xet | 1.3.2 | Apache-2.0 | Metadaten |
| huggingface_hub | 0.36.2 | Apache-2.0 | Metadaten |
| idna | 3.11 | BSD-3-Clause | Metadaten |
| importlib_metadata | 8.7.1 | Apache-2.0 | Metadaten |
| intervaltree | 3.2.1 | Apache-2.0 | Metadaten |
| Jinja2 | 3.1.6 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| jmespath | 1.1.0 | MIT | Metadaten |
| joblib | 1.5.3 | BSD-3-Clause | Metadaten |
| jsonlines | 4.0.0 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| julius | 0.2.7 | MIT | Metadaten |
| kiwisolver | 1.4.9 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| langdetect | 1.0.9 | Apache-2.0 | LICENSE-Datei (dist-info); Feld «License» nennt abweichend MIT |
| lightning | 2.6.1 | Apache-2.0 | Metadaten |
| lightning-utilities | 0.15.3 | Apache-2.0 | Metadaten |
| lxml | 6.0.2 | BSD-3-Clause | Metadaten |
| Mako | 1.3.10 | MIT | Metadaten |
| markdown-it-py | 4.0.0 | MIT | LICENSE-Datei (dist-info) |
| MarkupSafe | 3.0.3 | BSD-3-Clause | Metadaten |
| matplotlib | 3.10.8 | Matplotlib-Lizenz (PSF-basiert) | LICENSE-Datei (dist-info) |
| mdurl | 0.1.2 | MIT | LICENSE-Datei (dist-info) |
| more-itertools | 10.8.0 | MIT | Metadaten |
| mpld3 | 0.5.12 | BSD-3-Clause | Metadaten |
| mpmath | 1.3.0 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| multidict | 6.7.1 | Apache-2.0 | Metadaten |
| networkx | 3.6.1 | BSD-3-Clause | Metadaten |
| numpy | 2.4.2 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | Metadaten |
| opentelemetry-api | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-exporter-otlp | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-exporter-otlp-proto-common | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-exporter-otlp-proto-grpc | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-exporter-otlp-proto-http | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-proto | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-sdk | 1.39.1 | Apache-2.0 | Metadaten |
| opentelemetry-semantic-conventions | 0.60b1 | Apache-2.0 | Metadaten |
| optuna | 4.7.0 | MIT | LICENSE-Datei (dist-info) |
| packaging | 26.0 | Apache-2.0 OR BSD-2-Clause | Metadaten |
| pandas | 3.0.1 | BSD-3-Clause | Metadaten |
| pillow | 12.1.1 | MIT-CMU (plus gebündelte Bibliotheken, siehe oben) | Metadaten |
| pptree | 3.1 | MIT | Repository (github.com/clemtoy/pptree) |
| primePy | 1.3 | MIT | Repository (github.com/janaindrajit/primePy) |
| propcache | 0.4.1 | Apache-2.0 | Metadaten |
| protobuf | 6.33.5 | BSD-3-Clause | Metadaten |
| psutil | 7.2.2 | BSD-3-Clause | Metadaten |
| pyannote-audio | 4.0.4 | MIT | LICENSE-Datei (dist-info) |
| pyannote-core | 6.0.1 | MIT | LICENSE-Datei (dist-info) |
| pyannote-database | 6.1.1 | MIT | LICENSE-Datei (dist-info) |
| pyannote-metrics | 4.0.0 | MIT | LICENSE-Datei (dist-info) |
| pyannote-pipeline | 4.0.0 | MIT | LICENSE-Datei (dist-info) |
| pyannoteai-sdk | 0.4.0 | MIT | LICENSE-Datei (dist-info) |
| pycparser | 3.0 | BSD-3-Clause | Metadaten |
| Pygments | 2.19.2 | BSD-2-Clause | Metadaten |
| pyparsing | 3.3.2 | MIT | Metadaten |
| PySocks | 1.7.1 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| python-dateutil | 2.9.0.post0 | Apache-2.0 AND BSD-3-Clause | Metadaten (Dual License) |
| pytorch-lightning | 2.6.1 | Apache-2.0 | Metadaten |
| pytorch-metric-learning | 2.9.0 | MIT | LICENSE-Datei (dist-info) |
| pytorch_revgrad | 0.2.0 | MIT | LICENSE-Datei (dist-info) |
| PyYAML | 6.0.3 | MIT | Metadaten |
| regex | 2026.2.19 | Apache-2.0 AND CNRI-Python | Metadaten |
| requests | 2.32.5 | Apache-2.0 | Metadaten |
| rich | 14.3.3 | MIT | Metadaten |
| s3transfer | 0.16.0 | Apache-2.0 | Metadaten |
| safetensors | 0.7.0 | Apache-2.0 | LICENSE-Datei (dist-info) |
| scikit-learn | 1.8.0 | BSD-3-Clause | Metadaten |
| scipy | 1.17.1 | BSD-3-Clause (plus gebündelte Bibliotheken, siehe oben) | LICENSE-Datei (dist-info) |
| segtok | 1.5.11 | MIT | Metadaten |
| sentencepiece | 0.2.1 | Apache-2.0 | Repository (github.com/google/sentencepiece) |
| six | 1.17.0 | MIT | Metadaten |
| sortedcontainers | 2.4.0 | Apache-2.0 | Metadaten |
| soundfile | 0.13.1 | BSD-3-Clause (gebündeltes libsndfile: LGPL-2.1, siehe oben) | Metadaten |
| soupsieve | 2.8.3 | MIT | Metadaten |
| sqlitedict | 2.1.0 | Apache-2.0 | Metadaten |
| sympy | 1.14.0 | BSD-3-Clause | LICENSE-Datei (dist-info) |
| tabulate | 0.9.0 | MIT | Metadaten |
| threadpoolctl | 3.6.0 | BSD-3-Clause | Metadaten |
| tokenizers | 0.22.2 | Apache-2.0 | Repository (github.com/huggingface/tokenizers) |
| torch | 2.10.0 | BSD-3-Clause (plus NOTICE) | Metadaten |
| torch-audiomentations | 0.12.0 | MIT | Metadaten |
| torchaudio | 2.10.0 | BSD-2-Clause | LICENSE-Datei (dist-info) |
| torchcodec | 0.10.0 | BSD-3-Clause | Metadaten |
| torchmetrics | 1.8.2 | Apache-2.0 | Metadaten |
| torch_pitch_shift | 1.2.5 | MIT | LICENSE-Datei (dist-info) |
| tqdm | 4.67.3 | MPL-2.0 AND MIT | Metadaten |
| transformer-smaller-training-vocab | 0.4.2 | MIT | Metadaten |
| transformers | 4.57.6 | Apache-2.0 | Metadaten |
| typing_extensions | 4.15.0 | PSF-2.0 | Metadaten |
| urllib3 | 2.6.3 | MIT | Metadaten |
| wcwidth | 0.6.0 | MIT | Metadaten |
| Wikipedia-API | 0.9.0 | MIT | Metadaten |
| wrapt | 2.1.1 | BSD-2-Clause | Metadaten |
| yarl | 1.22.0 | Apache-2.0 | Metadaten |
| zipp | 3.23.0 | MIT | Metadaten |

Lizenzen im Überblick: MIT 46, Apache-2.0 35, BSD-3-Clause 25, BSD-2-Clause 3, PSF-2.0 2, MPL-2.0 2 (certifi, tqdm), sowie je eine Kombination bei numpy, regex, packaging, aiohttp, python-dateutil, pillow (MIT-CMU) und matplotlib (Matplotlib-Lizenz).

Bei der Auflösung fehlender oder widersprüchlicher Angaben ist Folgendes aufgefallen:

- **Ohne Lizenzangabe in den Metadaten:** pptree, primePy, sentencepiece und tokenizers. Die Lizenz wurde aus dem jeweiligen Repository ermittelt. Diese vier Pakete werden ohne jede Lizenzdatei ausgeliefert.
- **Ohne SPDX-Ausdruck, aber mit Lizenzdatei:** die pyannote-Pakete, Jinja2, markdown-it-py, mdurl, optuna, safetensors, kiwisolver, torchaudio, bioc, pytorch-metric-learning, pytorch_revgrad und torch_pitch_shift. Die Lizenz stammt aus der Lizenzdatei.
- **Widerspruch bei langdetect:** Das Metadaten-Feld `License` nennt MIT, Classifier und Lizenzdatei nennen Apache-2.0. Massgeblich ist die Lizenzdatei.

## Befunde

### Modelle

1. **Swiss-German-Whisper: Einsatz in Therapiepraxen nicht zulässig.** Das Modell Flurin17/whisper-large-v3-turbo-swiss-german steht seit dem 17. April 2026 unter CC BY-NC 4.0, und die von TheraScript am 22. April 2026 konvertierte Revision trägt bereits diese Lizenz. Die Lizenz erlaubt die Nutzung nur zu nicht-kommerziellen Zwecken (Abschnitt 2(a)(1) und 1(i)). Der Einsatz in einer entgeltlichen Therapiepraxis fällt nicht darunter. Die Weitergabe über R2 ist nur mit Namensnennung und Kennzeichnung der Konvertierung zulässig, und beides fehlt. Die App bietet das Modell ohne Hinweis auf die NC-Bedingung an.
2. **flair/ner-german-large: Weitergabe und Einsatz unklar.** Das Modell hat keine Lizenz, und seine Trainingsdaten (CoNLL-03 German aus der Frankfurter Rundschau im ECI-Korpus) sind nur für Forschungszwecke lizenziert. TheraScript verteilt zudem eine veränderte Fassung (fp16). Das Modell ist ein Pflichtmodell, ohne das die App nicht pseudonymisiert. Eine schriftliche Erlaubnis der flair-Maintainer würde die Frage klären.
3. **Gemma 3 4B (v0.8.13): Weitergabebedingungen nicht erfüllt.** Die Gemma Terms of Use verlangen in Abschnitt 3.1 eine Notice-Datei, eine Kopie der Terms, die vertragliche Weitergabe der Nutzungsbeschränkungen und die Kennzeichnung von Änderungen. Keiner dieser Punkte ist in v0.8.13 oder auf R2 erfüllt, und die Datei liegt für v0.8.13 weiterhin auf R2. Der Einsatz in Therapiepraxen ist nur unter Einhaltung der Prohibited Use Policy zulässig (2.5.8 Einwilligungen bei sensiblen Daten, 3.4 keine automatisierten Entscheidungen im Gesundheitswesen).
4. **Fehlende Namensnennung bei den übrigen Modellen.** Bei allen Modellen ausser Gemma 4 E2B in `main` fehlt die geforderte Namensnennung, sowohl in der App als auch auf R2:
   - MIT-Hinweise: Whisper/OpenAI, pyannote 3.1, segmentation-3.0, XLM-RoBERTa.
   - Apache-2.0-Lizenzkopie und Änderungsvermerk: German-Whisper.
   - CC-BY-Angaben: community-1, wespeaker.
   - CC-BY-NC-Angaben: Swiss-German-Whisper.
5. **Gated pyannote-Modelle über R2.** speaker-diarization-3.1, community-1 und segmentation-3.0 sind auf Hugging Face nur nach Zustimmung zur Weitergabe der Kontaktdaten erhältlich. Die Lizenzen (MIT bzw. CC BY 4.0) erlauben die Weitergabe. Der vollständige Text der Zugangsbedingungen ist nur nach Login einsehbar und wurde nicht geprüft.

### Software

6. **Keine Sammeldatei mit Lizenzhinweisen im App-Paket.** Das DMG enthält keine Lizenzübersicht. Folgende Hinweise fehlen:
   - `LICENSES.chromium.html` von Electron mit den Hinweisen zu Chromium, Node.js, FFmpeg und weiteren Komponenten, ebenso die Electron-LICENSE.
   - Die Lizenzen von whisper.cpp, llama.cpp, ggml, cpp-httplib und nlohmann/json.
   - OpenSSL (Apache-2.0 verlangt eine Lizenzkopie), libomp sowie die statisch in CPython gelinkten Komponenten (OpenSSL 3.5.4, libffi, mpdecimal, bzip2, Expat).
   - Die Lizenztexte der 41 in das Renderer-Bundle gebündelten npm-Pakete, darunter React, Tiptap, ProseMirror, linkifyjs und lucide-react.
   - Die Lizenzdateien der Python-Pakete pptree, primePy, sentencepiece und tokenizers.

   Vorhanden sind die Lizenzdateien der 61 npm-Pakete in `node_modules`, die meisten Python-dist-info-Lizenzen, der PSF-Text von CPython und in `main` der Apache-2.0-Text für Gemma 4. Die Seite «Über» nennt sieben Projekte namentlich, ohne Lizenzangaben. Das Ergänzen der Hinweise ist Gegenstand von Issue #173.
7. **FFmpeg in Electron (LGPL-2.1-or-later, mit proprietären Codecs).** Electron liefert `libffmpeg.dylib` als dynamische Bibliothek aus und erfüllt damit die strukturelle LGPL-Anforderung. Das App-Paket enthält aber weder den LGPL-Text noch einen Hinweis auf den Quellcode. Electron baut FFmpeg mit `proprietary_codecs = true` (unter anderem H.264 und AAC). Laut [FFmpeg Legal](https://ffmpeg.org/legal.html) können für solche Codecs Patentlizenzen relevant sein. TheraScript nutzt diese Codecs nicht, liefert sie aber mit. Eine mögliche Lösung wäre ein Electron-Build ohne proprietäre Codecs.
8. **libsndfile mit mpg123 und LAME (LGPL).** Die Bibliotheken stecken im Python-Paket soundfile und liegen als separate dynamische Bibliothek bei. Der LGPL-Text (`_soundfile_data/COPYING`) ist enthalten. Ein Hinweis auf den Quellcode bzw. ein Quellcode-Angebot nach LGPL-2.1 Abschnitt 6 fehlt.
9. **GCC-Laufzeit und libquadmath in SciPy.** libgfortran und libgcc_s stehen unter GPL-3.0-or-later mit GCC Runtime Library Exception, die die Weitergabe mit nicht-GPL-Software erlaubt. libquadmath steht unter LGPL-2.1-or-later und liegt als dynamische Bibliothek bei. Die Lizenztexte sind in `scipy-1.17.1.dist-info/LICENSE.txt` enthalten. Ein Quellcode-Hinweis für libquadmath fehlt.
10. **MPL-2.0 (certifi, tqdm).** Diese Pakete stehen unter einer Copyleft-Lizenz auf Dateiebene. Sie werden unverändert und als Python-Quellcode ausgeliefert, damit ist die Pflicht zur Quellcode-Verfügbarkeit erfüllt.
11. **FreeType in Pillow.** Die FreeType License (FTL), die Pillow alternativ zu GPL-2.0 wählt, verlangt eine Nennung in der Dokumentation. Der Text liegt nur in der Lizenzdatei von Pillow.
12. **Keine GPL-Komponente ohne Ausnahme.** Das App-Paket enthält keine Komponente unter GPL ohne Ausnahmeklausel. Das CPython von python-build-standalone verzichtet bewusst auf readline und GDBM, ncurses, libedit und zlib kommen aus macOS.
