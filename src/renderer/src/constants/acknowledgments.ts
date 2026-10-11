import APACHE_2_0 from '../assets/licenses/apache-2.0.txt?raw'
import BETTER_SQLITE3 from '../assets/licenses/better-sqlite3.txt?raw'
import ELECTRON from '../assets/licenses/electron.txt?raw'
import FAIRSEQ_XLM_ROBERTA from '../assets/licenses/fairseq-xlm-roberta.txt?raw'
import FLAIR from '../assets/licenses/flair.txt?raw'
import LLAMA_CPP from '../assets/licenses/llama-cpp.txt?raw'
import OPENAI_WHISPER from '../assets/licenses/openai-whisper.txt?raw'
import PDFJS_DIST from '../assets/licenses/pdfjs-dist.txt?raw'
import PYANNOTE_AUDIO from '../assets/licenses/pyannote-audio.txt?raw'
import PYANNOTE_SEGMENTATION from '../assets/licenses/pyannote-segmentation.txt?raw'
import TIPTAP from '../assets/licenses/tiptap.txt?raw'
import WHISPER_CPP from '../assets/licenses/whisper-cpp.txt?raw'

/**
 * Lizenzhinweise für alles, was TheraScript mitliefert (App-Bundle) oder über
 * R2 weiterverteilt (Modelle). MIT und Apache 2.0 verlangen bei Weitergabe den
 * Lizenztext samt Copyright-Zeile — die Texte unter assets/licenses/ sind die
 * Original-Dateien der jeweiligen Pakete bzw. Repos, nicht nachgeschrieben.
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
    name: 'Whisper Large V3 Turbo Swiss German',
    catalogIds: ['whisper-large-v3-turbo-swiss'],
    description: 'Spracherkennung Schweizerdeutsch — Flurin17',
    license: 'CC BY-NC 4.0',
    notice: ccNotice(
      'Flurin17/whisper-large-v3-turbo-swiss-german (Feinabstimmung von OpenAI Whisper Large V3 Turbo), https://huggingface.co/Flurin17/whisper-large-v3-turbo-swiss-german',
      'Creative Commons Attribution-NonCommercial 4.0 International',
      'https://creativecommons.org/licenses/by-nc/4.0/'
    )
  },
  {
    name: 'pyannote segmentation-3.0 / speaker-diarization-3.1',
    catalogIds: ['pyannote-suite'],
    description: 'Sprechererkennung — © CNRS',
    license: 'MIT',
    notice: PYANNOTE_SEGMENTATION
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
      'flair/ner-german-large, https://huggingface.co/flair/ner-german-large\n\nDie Modellkarte nennt keine Lizenz. Die flair-Bibliothek selbst steht unter MIT (siehe oben).'
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
