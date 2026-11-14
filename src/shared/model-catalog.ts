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

/**
 * Wie ein Suchmodell (Gruppe `search`, Epic #192) Texte einbettet. Steht im
 * Katalog, damit ein anderes Modell ohne Code-Umbau passt (NFR-9/10): der
 * Suchdienst bekommt Prompts und Grenzen von hier.
 */
export interface EmbeddingConfig {
  /** Länge der Vektoren. */
  dim: number
  /** Vorangestellt vor jede Suchanfrage. */
  queryPrompt: string
  /** Vorangestellt vor jeden Abschnitt beim Aufbereiten. */
  documentPrompt: string
  /** Höchstens so viele Tokens pro Text (inkl. Prompt). */
  maxTokens: number
  /** Auffüllen auf Vielfache davon — Speicherschutz auf MPS, kein Tuning. */
  padMultiple: number
}

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
  /**
   * Pflichtmodell, das die App aber nicht aussperrt (Epic #192, Suche): die
   * Ersteinrichtung lädt es mit, `checkRequiredAndActiveExist` ignoriert es,
   * und fehlt es, lädt der `SearchModelProvisioner` es im Hintergrund nach.
   */
  deferrable?: boolean
  /**
   * `false`: das Artefakt liegt noch nicht auf R2. Der Eintrag steht schon mit
   * echtem Hash und echter Grösse im Katalog, ist aber für alle
   * Laufzeit-Zugriffe unsichtbar — kein Download, kein Manifest-Eintrag, keine
   * Zeile in den Einstellungen (`isPublished`). Fehlt das Feld, gilt der
   * Eintrag als veröffentlicht. Schrittfolge zum Umlegen:
   * docs/product/operations/model-pipeline.md, «Publishing a new model».
   */
  published?: boolean
  /** Nur für die Gruppe `search`. */
  embedding?: EmbeddingConfig
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

/**
 * Ordner des Suchmodells unter models/ (Epic #192). Bewusst auf oberster
 * Ebene und ohne «/»: die Update-Beschreibung lässt Archive nur in einem
 * eigenen Ordner direkt unter models/ zu (`layoutProblem` in
 * model-update-schemas.ts, gleich in v0.10.x) — sonst verwürfe jede App den
 * Manifest-Eintrag. Der Name trägt die Version (neue Artefakt-Generation =
 * neuer Ordner). Einzige Quelle für alle, die den Standardpfad brauchen.
 */
export const SEARCH_MODEL_DIR_NAME = 'search-embeddinggemma-2-text-v1'
/** Letzte Datei im Tarball — liegt sie da, ist das Modell vollständig entpackt. */
export const SEARCH_MODEL_READY_FILE = 'READY'

/**
 * Altes Sentinel für «Hash noch nicht synchronisiert» — wirkt wie
 * `published: false`. Neue Einträge nutzen `published: false` mit echtem Hash.
 */
export const PLACEHOLDER_SHA256 = '0'.repeat(64)

/**
 * Darf die App den Eintrag benutzen (laden, anbieten, ins Manifest
 * schreiben)? Nein, solange `published: false` gesetzt ist oder der Hash
 * noch der Platzhalter ist.
 */
export function isPublished(m: Pick<ModelDefinition, 'published' | 'sha256'>): boolean {
  return m.published !== false && m.sha256 !== PLACEHOLDER_SHA256
}

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
    // Suchmodell (Epic #192, #209/#210): Text-Encoder von EmbeddingGemma 2
    // (Apache 2.0), gepackt von scripts/package-models.sh search. Grösse und
    // sha256 sind die des lokal erzeugten, reproduzierbaren Pakets — das
    // Artefakt liegt NOCH NICHT auf R2, deshalb `published: false`. Vor dem
    // Umlegen die Werte des HOCHGELADENEN Objekts prüfen (model-hash-sync
    // gotcha, docs/product/operations/model-pipeline.md). Der Ordner trägt die
    // Version: ein inkompatibles Artefakt braucht neue ID UND neuen Ordner.
    id: 'embeddinggemma-2-text',
    label: 'EmbeddingGemma 2',
    url: `${R2_CDN}/embeddinggemma-2-text-v1.tar.gz`,
    relativePath: SEARCH_MODEL_DIR_NAME,
    // READY ist die letzte Datei im Tarball: liegt sie da, ist alles entpackt
    checkPath: `${SEARCH_MODEL_DIR_NAME}/${SEARCH_MODEL_READY_FILE}`,
    sizeBytes: 430_211_881,
    sha256: '49e225895475004c699f08390f822e92a1fa8be4882e03e50d44c50f3badf4f8',
    archive: true,
    group: 'search',
    isRequired: true,
    deferrable: true,
    published: false,
    embedding: {
      dim: 768,
      queryPrompt: 'task: search result | query: ',
      documentPrompt: 'title: none | text: ',
      maxTokens: 1024,
      padMultiple: 128
    },
    description:
      'Findet Textstellen nach ihrer Bedeutung, auch wenn die Suchanfrage andere Worte verwendet. Läuft lokal auf dem Mac.',
    languages: ['multi'],
    hfRepo: 'google/embeddinggemma-2'
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

/**
 * Pflichtmodelle, die noch `published: false` tragen, obwohl die öffentlichen
 * Texte sie schon beschreiben (Suchmodell, Epic #192). `release.sh` bricht ab,
 * solange die Liste nicht leer ist (`scripts/check-unpublished-models.ts`):
 * README und Website nennen ab dem Merge nach main den Download mit dem
 * Modell — eine App ohne es widerspräche ihnen.
 */
export function unpublishedRequiredModels(
  defs: readonly Pick<ModelDefinition, 'id' | 'isRequired' | 'published' | 'sha256'>[]
): string[] {
  return defs.filter((m) => m.isRequired === true && !isPublished(m)).map((m) => m.id)
}

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
  },
  // Swiss-German-Fine-Tune (Flurin17) unter CC BY-NC 4.0 — keine kommerzielle
  // Nutzung, also nicht für Therapiepraxen (#185). Ersatz: das Standardmodell,
  // das Schweizerdeutsch mit `-l de` ins Hochdeutsche normalisiert.
  {
    id: 'whisper-large-v3-turbo-swiss',
    label: 'Whisper Large V3 Turbo (Swiss-German)',
    group: 'asr',
    relativePath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin'
  }
]
