import type { ModelGroup } from './validation/model-catalog-schemas'

/**
 * Single source of truth for the model catalog. Imported by
 * `src/main/services/ModelDownloadService.ts` for runtime use and by
 * `scripts/extract-model-definitions.ts` (run via tsx) so that
 * `scripts/publish-manifest.sh` can derive the manifest entries instead of
 * mirroring this list in bash.
 *
 * Keep this file dependency-free of Node/Electron APIs so it can be loaded
 * standalone by the extractor.
 */

export interface ModelDefinition {
  id: string
  label: string
  url: string
  sizeBytes: number
  sha256: string
  // For flat files: relative path to the final file (e.g., 'asr/ggml-large-v3-turbo-q5_0.bin')
  // For archives: relative path of the extraction directory (e.g., 'diarization')
  relativePath: string
  // If true, download is a tar.gz that needs extraction into relativePath
  archive?: boolean
  // Path to check for existence (relative to modelsDir). Used by checkModelsExist().
  checkPath: string
  group?: ModelGroup
  isRequired?: boolean
  description?: string
  languages?: string[]
  accuracyScore?: number
  speedScore?: number
  // Nur für Diarization relevant — pyannote-Pipelines laden via from_pretrained(hfIdentifier).
  hfIdentifier?: string
  /** HuggingFace repo path for the "view on HuggingFace" link in the UI. */
  hfRepo?: string
}

export const R2_CDN = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev'

// Model definitions — downloads from Cloudflare R2 CDN
export const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    group: 'asr',
    isRequired: false,
    description:
      'Unterstützt alle Sprachen (Deutsch, Englisch, Französisch, Italienisch, …). Empfohlen als Standardmodell oder wenn Aufnahmen mehrsprachig geführt werden.',
    languages: ['multi'],
    accuracyScore: 0.8,
    speedScore: 0.9,
    hfRepo: 'openai/whisper-large-v3-turbo'
  },
  {
    id: 'whisper-large-v3-turbo-german',
    label: 'Whisper Large V3 Turbo (German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-german-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-german-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-german-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '15e92e3db0993c52fffa781513eec9253475331c1be808f8fb409285c9d9d030',
    group: 'asr',
    isRequired: false,
    description:
      'Auf Hochdeutsch optimiert (Basis: primeline/whisper-large-v3-turbo-german). Präziser bei Standarddeutsch als das multilinguale Modell. Nicht geeignet für starke Schweizerdeutsch-Mundart oder andere Sprachen.',
    languages: ['de'],
    accuracyScore: 0.87,
    speedScore: 0.9,
    hfRepo: 'primeline/whisper-large-v3-turbo-german'
  },
  {
    id: 'whisper-large-v3-turbo-swiss',
    label: 'Whisper Large V3 Turbo (Swiss-German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-swiss-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '2d56e773724a247360067b527417842b81d25ff891fed014341a6844f15ea612',
    group: 'asr',
    isRequired: false,
    description:
      'Spezialisiert auf starke Schweizerdeutsch-Dialekte (Basis: Flurin17/whisper-large-v3-turbo-swiss-german). Merklich präzisere Transkription bei ausgeprägter Mundart. Nicht geeignet für andere Sprachen.',
    languages: ['de-CH', 'de'],
    accuracyScore: 0.9,
    speedScore: 0.85,
    hfRepo: 'Flurin17/whisper-large-v3-turbo-swiss-german'
  },
  {
    id: 'pyannote-suite',
    label: 'Sprechererkennung (pyannote)',
    url: `${R2_CDN}/pyannote-suite.tar.gz`,
    relativePath: 'diarization',
    // Community-1-Ordner ist Teil der Suite und wird von pyannote 4.x auch für die 3.1-Pipeline
    // als PLDA-Quelle geladen. Wenn er da ist, ist die ganze Suite funktional.
    checkPath: 'diarization/models--pyannote--speaker-diarization-community-1',
    sizeBytes: 60_664_796,
    sha256: 'ba9a241906fb9880791f448f959b12beae39d7e0ed066eaf62b7bcec805bc87e',
    archive: true,
    group: 'diarization',
    isRequired: true
  },
  {
    id: 'flair-ner-german-large',
    label: 'flair/ner-german-large',
    // -v3 (Issue #131): fp16-Checkpoint, flair castet beim Laden auf fp32 hoch
    // (Hintergrund: needs_fast_checkpoint in python_sidecar/ner_service.py).
    // Jede Artefakt-Generation bekommt einen neuen Dateinamen statt eines
    // R2-Overwrites: ältere App-Versionen verifizieren den First-Launch gegen
    // ihren eingebauten Hash und laden weiter ihr Artefakt (v1, v2).
    url: `${R2_CDN}/flair-ner-german-large-v3.tar.gz`,
    relativePath: 'ner',
    // checkPath zeigt bewusst auf den hf/-Tokenizer-Subtree (seit v2), nicht
    // auf das Modell selbst: v1-Installationen (ohne hf/) gelten damit als
    // "nicht installiert" → First-Launch lädt gezielt das aktuelle Tarball nach
    // (startModelDownload skippt Modelle mit existierendem checkPath; tar
    // extrahiert merge-artig über das bestehende ner/). Ohne diesen Marker
    // bliebe eine v1-Installation nach dem App-Update dauerhaft kaputt, sobald
    // der User das dismissbare Modell-Update wegklickt — ner_service.py läuft
    // offline und braucht den Tokenizer unter ner/hf/. v2-Installationen
    // funktionieren und bekommen v3 über das Manifest als Update angeboten.
    checkPath: 'ner/hf/hub/models--xlm-roberta-large',
    sizeBytes: 1_036_271_860,
    sha256: 'f80b005f1d0e18317376841e49dd4531a542419e60c644399f83f2a2fc428a20',
    archive: true,
    group: 'ner',
    isRequired: true,
    description:
      'Erkennt Personen, Orte, Organisationen und weitere benannte Entitäten in deutschem Text (Basis: flair/ner-german-large auf XLM-RoBERTa Large). Hohe Präzision auf Hochdeutsch (~92% F1). Ergänzt die Sperrliste mit modellbasierter Erkennung neuer Begriffe.',
    languages: ['de'],
    accuracyScore: 0.92,
    speedScore: 0.5,
    hfRepo: 'flair/ner-german-large'
  },
  {
    // Optionales Zusammenfassungsmodell — Googles offizielles QAT-GGUF, Apache 2.0
    // (löste Gemma 3 4B unter den Gemma Terms of Use ab, siehe RETIRED_MODELS).
    // sha256 + sizeBytes müssen dem auf R2 HOCHGELADENEN Objekt entsprechen
    // (model-hash-sync gotcha); sie sind identisch mit dem HF-LFS-Objekt.
    id: 'gemma-4-e2b-summarization',
    label: 'Gemma 4 E2B',
    url: `${R2_CDN}/gemma-4-E2B_q4_0-it.gguf`,
    relativePath: 'summarization/gemma-4-E2B_q4_0-it.gguf',
    checkPath: 'summarization/gemma-4-E2B_q4_0-it.gguf',
    sizeBytes: 3_349_516_256,
    sha256: 'fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634',
    group: 'summarization',
    isRequired: false,
    description:
      'Sprachmodell von Google. Versteht und erzeugt natürliche Sprache in mehreren Sprachen — hier eingesetzt für prägnante 2-Satz-Zusammenfassungen am Ende jeder Verarbeitung. Läuft komplett lokal auf der Apple-Silicon-GPU.',
    languages: ['de', 'en'],
    hfRepo: 'google/gemma-4-E2B-it-qat-q4_0-gguf'
  }
]

/** Ein aus dem Katalog entferntes Modell, dessen Datei noch auf Nutzer-Macs liegen kann. */
export interface RetiredModel {
  id: string
  /** Name, unter dem der Nutzer das Modell kannte — für das Banner. */
  label: string
  group: ModelGroup
  /** Datei bzw. Verzeichnis relativ zu modelsDir, wie es der alte Katalog schrieb. */
  relativePath: string
}

/**
 * Aus dem Katalog entfernte Modelle, deren Datei beim App-Start gelöscht wird
 * (`retireObsoleteModels`, läuft VOR dem Reconciler). Ohne diesen Eintrag
 * bliebe die Datei unsichtbar auf der Platte liegen — `deleteModel` kennt
 * nur Katalog-IDs — und der Reconciler meldete irreführend "nicht mehr
 * gefunden". Einträge nie entfernen: auch Nutzer, die mehrere Versionen
 * überspringen, müssen noch aufgeräumt werden.
 */
export const RETIRED_MODELS: RetiredModel[] = [
  // Gemma 3 4B unter den Gemma Terms of Use — abgelöst durch Gemma 4 E2B (Apache 2.0).
  {
    id: 'gemma-summarization',
    label: 'Gemma 3 4B Instruct',
    group: 'summarization',
    relativePath: 'summarization/google_gemma-3-4b-it-Q4_K_M.gguf'
  }
]
