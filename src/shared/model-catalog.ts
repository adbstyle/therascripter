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
}

export const R2_CDN = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev'

// Model definitions — downloads from Cloudflare R2 CDN
export const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo (Multilingual)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    group: 'asr',
    isRequired: false,
    description:
      'Unterstützt alle Sprachen (Deutsch, Englisch, Französisch, Italienisch, …). Empfohlen als Standardmodell oder wenn Sitzungen mehrsprachig geführt werden.',
    languages: ['multi'],
    accuracyScore: 0.8,
    speedScore: 0.9
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
    speedScore: 0.9
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
    speedScore: 0.85
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
    label: 'Anonymisierung (flair-ner-german-large)',
    url: `${R2_CDN}/flair-ner-german-large.tar.gz`,
    relativePath: 'ner',
    checkPath: 'ner/models/ner-german-large',
    sizeBytes: 1_741_706_626,
    sha256: '5dc0390c6d844d30648c4d950ee694eafeb01813e4d75e734cad6deede29d8a3',
    archive: true,
    group: 'ner',
    isRequired: true
  },
  {
    // Optional summarization model — Gemma 3 4B Instruct Q4_K_M (Gemma 4 E4B fallback,
    // see CLAUDE.md "Gemma 4 E4B GGUF source"). Hash + size must be re-synced after
    // running scripts/publish-manifest.sh per the model-hash-sync gotcha.
    id: 'gemma-summarization',
    label: 'Zusammenfassung (Gemma 3 4B Instruct)',
    url: `${R2_CDN}/gemma-3-4b-it-Q4_K_M.gguf`,
    relativePath: 'summarization/gemma-3-4b-it-Q4_K_M.gguf',
    checkPath: 'summarization/gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_490_000_000,
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    group: 'summarization',
    isRequired: false,
    description:
      'Lokales 4B-Parameter-Modell für 2-Satz-Zusammenfassungen deutscher Texte. Optional — kann später unter Einstellungen → Modelle nachgeladen werden.',
    languages: ['de', 'en']
  }
]
