import APACHE_2_0 from '../assets/licenses/apache-2.0.txt?raw'
import FAIRSEQ_XLM_ROBERTA from '../assets/licenses/fairseq-xlm-roberta.txt?raw'
import FLAIR from '../assets/licenses/flair.txt?raw'
import LLAMA_CPP from '../assets/licenses/llama-cpp.txt?raw'
import OPENAI_WHISPER from '../assets/licenses/openai-whisper.txt?raw'
import PYANNOTE_AUDIO from '../assets/licenses/pyannote-audio.txt?raw'
import PYANNOTE_SEGMENTATION from '../assets/licenses/pyannote-segmentation.txt?raw'
import WHISPER_CPP from '../assets/licenses/whisper-cpp.txt?raw'
// npm-Pakete: direkt aus node_modules, damit der Text nach Updates nicht veraltet
// (Pfad statt Paketname, weil deren "exports" die LICENSE nicht freigeben).
import BETTER_SQLITE3 from '../../../../node_modules/better-sqlite3/LICENSE?raw'
import ELECTRON from '../../../../node_modules/electron/LICENSE?raw'
import PDFJS_DIST from '../../../../node_modules/pdfjs-dist/LICENSE?raw'
import TIPTAP from '../../../../node_modules/@tiptap/core/LICENSE.md?raw'

/**
 * Lizenzhinweise für das, was TheraScript mitliefert (App-Bundle) oder über
 * R2 weiterverteilt (Modelle). Hauptkomponenten und alle Katalog-Modelle
 * einzeln, Python sowie weitere native und JavaScript-Bibliotheken als
 * Sammeleintrag. MIT und Apache 2.0 verlangen bei Weitergabe den Lizenztext
 * samt Copyright-Zeile — die Texte sind die Original-Dateien der jeweiligen
 * Pakete bzw. Repos (npm direkt aus node_modules), nicht nachgeschrieben.
 * CC BY verlangt Namensnennung und einen Verweis auf die Lizenz.
 *
 * Beim Hinzufügen oder Austauschen einer Komponente oder eines Katalog-Modells
 * hier mitziehen.
 */
export interface Acknowledgment {
  name: string
  description: string
  license: string
  /** Vollständiger Lizenztext (MIT/Apache) oder Namensnennung mit Lizenz-URL (CC). */
  notice: string
  /** Katalog-IDs (model-catalog.ts), deren Download dieses Werk enthält. */
  catalogIds?: string[]
}

const ccNotice = (attribution: string, license: string, url: string): string =>
  `${attribution}\n\nLizenz: ${license}\n${url}`

export const SOFTWARE_ACKNOWLEDGMENTS: Acknowledgment[] = [
  {
    name: 'whisper.cpp',
    description: 'Automatische Spracherkennung (ASR) — wandelt Audiodaten in Text um',
    license: 'MIT',
    notice: WHISPER_CPP
  },
  {
    name: 'pyannote.audio',
    description: 'Sprecherdiarisierung — erkennt und trennt verschiedene Gesprächspersonen',
    license: 'MIT',
    notice: PYANNOTE_AUDIO
  },
  {
    name: 'flair',
    description:
      'Named Entity Recognition (NER) — identifiziert Personen, Orte und andere Entitäten',
    license: 'MIT',
    notice: FLAIR
  },
  {
    name: 'llama.cpp',
    description: 'Lokale Zusammenfassung — führt das Sprachmodell auf dem Mac aus',
    license: 'MIT',
    notice: LLAMA_CPP
  },
  {
    name: 'Python',
    description:
      'Laufzeit für Sprechererkennung und Pseudonymisierung, mit Open-Source-Bibliotheken',
    license: 'je Bibliothek',
    notice:
      'TheraScript nutzt Python und verschiedene Open-Source-Bibliotheken. Jede steht unter ihrer eigenen Lizenz; die Lizenztexte liegen den Bibliotheken im App-Paket bei.'
  },
  {
    name: 'TipTap',
    description: 'Review-Editor — ermöglicht die Bearbeitung des pseudonymisierten Textes',
    license: 'MIT',
    notice: TIPTAP
  },
  {
    name: 'Electron',
    description: 'Desktop-App-Framework — ermöglicht die native macOS-Anwendung',
    license: 'MIT',
    notice: ELECTRON
  },
  {
    name: 'pdfjs-dist',
    description: 'PDF-Textextraktion — liest Text aus importierten PDF-Dokumenten aus',
    license: 'Apache License 2.0',
    notice: PDFJS_DIST
  },
  {
    name: 'better-sqlite3',
    description: 'Lokale Datenbank — speichert Transkriptionen und Sperrliste auf dem Gerät',
    license: 'MIT',
    notice: BETTER_SQLITE3
  },
  {
    name: 'Weitere Bibliotheken',
    description: 'OpenSSL, LLVM OpenMP (libomp) und JavaScript-Bibliotheken aus npm',
    license: 'Apache 2.0, MIT u. a.',
    notice:
      'TheraScript nutzt weitere Open-Source-Bibliotheken: OpenSSL und LLVM OpenMP (libomp) als Teil der lokalen Zusammenfassung sowie verschiedene JavaScript-Bibliotheken aus dem npm-Ökosystem. Jede steht unter ihrer eigenen Lizenz. OpenSSL und LLVM OpenMP stehen unter der Apache License 2.0 (libomp mit LLVM Exception):\n\n' +
      APACHE_2_0
  }
]

export const MODEL_ACKNOWLEDGMENTS: Acknowledgment[] = [
  {
    name: 'Whisper Large V3 Turbo',
    catalogIds: ['whisper-large-v3-turbo'],
    description: 'Spracherkennung (Standardmodell) — © OpenAI',
    license: 'MIT',
    notice: OPENAI_WHISPER
  },
  {
    name: 'Whisper Large V3 Turbo German',
    catalogIds: ['whisper-large-v3-turbo-german'],
    description: 'Spracherkennung Deutsch — Florian Zimmermeister (primeline)',
    license: 'Apache License 2.0',
    notice: APACHE_2_0
  },
  {
    name: 'pyannote segmentation-3.0',
    catalogIds: ['pyannote-suite'],
    description: 'Sprechererkennung — © CNRS',
    license: 'MIT',
    notice: PYANNOTE_SEGMENTATION
  },
  {
    name: 'pyannote speaker-diarization-3.1',
    catalogIds: ['pyannote-suite'],
    description: 'Sprechererkennung — pyannote',
    license: 'MIT',
    // Das Repo enthält nur die Pipeline-Konfiguration und keine eigene
    // Lizenzdatei — die Modellkarte nennt MIT.
    notice:
      'pyannote/speaker-diarization-3.1, https://huggingface.co/pyannote/speaker-diarization-3.1\n\n' +
      'Lizenz laut Modellkarte: MIT. Das Repository enthält keine eigene Lizenzdatei; die Pipeline nutzt segmentation-3.0, dessen Lizenztext hier wiedergegeben ist:\n\n' +
      PYANNOTE_SEGMENTATION
  },
  {
    name: 'pyannote speaker-diarization-community-1',
    catalogIds: ['pyannote-suite'],
    description: 'Sprechererkennung — pyannote',
    license: 'CC BY 4.0',
    notice: ccNotice(
      'pyannote/speaker-diarization-community-1, https://huggingface.co/pyannote/speaker-diarization-community-1',
      'Creative Commons Attribution 4.0 International',
      'https://creativecommons.org/licenses/by/4.0/'
    )
  },
  {
    name: 'pyannote wespeaker-voxceleb-resnet34-LM',
    catalogIds: ['pyannote-suite'],
    description: 'Sprecher-Embeddings — pyannote, basierend auf WeSpeaker',
    license: 'CC BY 4.0',
    notice: ccNotice(
      'pyannote/wespeaker-voxceleb-resnet34-LM (Wrapper um das WeSpeaker-Modell wespeaker-voxceleb-resnet34-LM), https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM',
      'Creative Commons Attribution 4.0 International',
      'https://creativecommons.org/licenses/by/4.0/'
    )
  },
  {
    name: 'flair ner-german-large',
    catalogIds: ['flair-ner-german-large'],
    description: 'Pseudonymisierung — Stefan Schweter, Alan Akbik',
    license: 'Lizenz nicht angegeben',
    notice:
      'flair/ner-german-large von Stefan Schweter und Alan Akbik, https://huggingface.co/flair/ner-german-large\n\n' +
      'Herzlichen Dank an die Autoren — dieses Modell erkennt die Namen, Orte und weiteren Angaben, die TheraScript pseudonymisiert.\n\n' +
      'Transparenzhinweis: Die Modellkarte deklariert keine Lizenz. TheraScript verteilt das Modell weiter, für schnelleres Laden auf halbe Genauigkeit (fp16) umgespeichert. Die flair-Bibliothek, mit der es geladen wird, steht unter MIT (siehe Software).'
  },
  {
    name: 'XLM-RoBERTa Large (Tokenizer)',
    catalogIds: ['flair-ner-german-large'],
    description: 'Teil der Pseudonymisierung — © Facebook, Inc. and its affiliates',
    license: 'MIT',
    notice: FAIRSEQ_XLM_ROBERTA
  },
  {
    name: 'Gemma 4 E2B',
    catalogIds: ['gemma-4-e2b-summarization'],
    description: 'Zusammenfassung — © Google LLC',
    license: 'Apache License 2.0',
    notice: APACHE_2_0
  }
]
