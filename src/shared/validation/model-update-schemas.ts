import { z } from 'zod'

const semver = z.string().regex(/^\d+\.\d+\.\d+$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 muss 64 Hex-Zeichen sein')
/** Updates nur verschlüsselt laden (#167 AK 7); die Echtheit sichert der sha256. */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'nur https-Adressen')
const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/i, 'nur a-z, 0-9, Bindestrich und Punkt erlaubt')

// Ein Pfad-Segment beginnt mit Buchstabe oder Ziffer: schliesst «.», «..» und
// versteckte Ordner (.update, .backup, .staging) aus, ebenso «/» am Anfang,
// doppelte «/», Backslash und Steuerzeichen.
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@+=,-]*$/

/**
 * Relativer Pfad unterhalb von models/, wie ihn die Update-Beschreibung für
 * ein Modell nennt (#167). Die Beschreibung ist signiert — das hier ist die
 * zweite Linie, falls doch etwas Unerwartetes drinsteht.
 */
export function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 200 && path.split('/').every((s) => PATH_SEGMENT.test(s))
}
const safePath = z.string().refine(isSafeRelativePath, 'unsicherer Pfad')

interface LayoutFields {
  relativePath?: string
  checkPath?: string
  archive?: boolean
}

/** Zusammenhang der Ablage-Angaben eines Modells; null = in Ordnung. */
function layoutProblem(m: LayoutFields): string | null {
  if ((m.relativePath === undefined) !== (m.checkPath === undefined)) {
    return 'relativePath und checkPath nur gemeinsam'
  }
  if (m.relativePath === undefined || m.checkPath === undefined) return null
  if (m.checkPath !== m.relativePath && !m.checkPath.startsWith(`${m.relativePath}/`)) {
    return 'checkPath liegt nicht in relativePath'
  }
  // Ein Archiv ersetzt beim Update seinen ganzen Ordner — nur eigene Ordner
  // direkt unter models/ (ner, diarization), nie einen geteilten wie asr/
  if (m.archive && m.relativePath.includes('/')) return 'Archiv nur in eigenem Ordner'
  return null
}

function refineLayout(m: LayoutFields, ctx: z.RefinementCtx): void {
  const problem = layoutProblem(m)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
}

const manifestModelFields = {
  id: modelId,
  version: z.string().min(1),
  label: z.string().min(1),
  url: httpsUrl,
  sha256,
  sizeBytes: z.number().int().positive(),
  /** Ab welcher App-Version das Artefakt passt (Issue #163); fehlt bei alten Manifesten. */
  minAppVersion: semver.optional()
}

/**
 * Ein Modell-Eintrag der Update-Beschreibung. Seit #167 auch mit der Ablage
 * (Ordner, Archiv, Prüfpfad, Pflicht): So kann eine App Modelle mitladen, die
 * erst die neue Version braucht und ihr eigener Katalog nicht kennt. Ältere
 * Apps ignorieren die Felder (zod verwirft unbekannte Schlüssel).
 */
export const ManifestModelSchema = z
  .object({
    ...manifestModelFields,
    relativePath: safePath.optional(),
    checkPath: safePath.optional(),
    archive: z.boolean().optional(),
    // Freier Text statt Aufzählung: eine künftige Gruppe darf ältere Apps nicht stören
    group: z.string().max(32).optional(),
    required: z.boolean().optional()
  })
  .superRefine(refineLayout)

/** Installationspaket der neuesten Version (Issue #163); fehlt bei alten Manifesten. */
export const ManifestAppSchema = z.object({
  version: semver,
  url: httpsUrl,
  sha256,
  sizeBytes: z.number().int().positive()
})

export const ManifestSchema = z.object({
  generatedAt: z.string().min(1),
  latestAppVersion: semver.optional(),
  // Einträge einzeln prüfen (parseManifest): ein fehlerhafter kostet nur sich selbst
  app: z.unknown().optional(),
  models: z.array(z.unknown()).min(1)
})

export type ManifestModelInput = z.infer<typeof ManifestModelSchema>
export type ManifestAppInput = z.infer<typeof ManifestAppSchema>

export interface Manifest {
  generatedAt: string
  latestAppVersion?: string
  app?: ManifestAppInput
  models: ManifestModelInput[]
}

/**
 * Liest eine (bereits signaturgeprüfte) Update-Beschreibung. Wirft nur, wenn
 * ihr Gerüst nicht stimmt; ein unbrauchbarer App- oder Modell-Eintrag fällt
 * einzeln weg — sonst legte z. B. eine neue Modellgruppe alle Updates still.
 */
export function parseManifest(raw: unknown, log: (message: string) => void = () => {}): Manifest {
  const base = ManifestSchema.parse(raw)
  const models: ManifestModelInput[] = []
  for (const entry of base.models) {
    const parsed = ManifestModelSchema.safeParse(entry)
    if (parsed.success) models.push(parsed.data)
    else log(`Update-Beschreibung: Modell-Eintrag verworfen: ${parsed.error.issues[0]?.message}`)
  }
  let app: ManifestAppInput | undefined
  if (base.app !== undefined) {
    const parsed = ManifestAppSchema.safeParse(base.app)
    if (parsed.success) app = parsed.data
    else log(`Update-Beschreibung: App-Eintrag verworfen: ${parsed.error.issues[0]?.message}`)
  }
  return {
    generatedAt: base.generatedAt,
    ...(base.latestAppVersion ? { latestAppVersion: base.latestAppVersion } : {}),
    ...(app ? { app } : {}),
    models
  }
}

/**
 * Ein Modell im Update-Paket (#167): Eintrag der Update-Beschreibung mit
 * aufgelöster Ablage. Auch so gespeichert (Einstellung appUpdate) und beim
 * Lesen erneut geprüft — die Oberfläche liefert nie Update-Daten.
 */
export const BundleModelSchema = z
  .object({
    ...manifestModelFields,
    relativePath: safePath,
    checkPath: safePath,
    archive: z.boolean(),
    required: z.boolean(),
    /** update = neue Fassung eines installierten Modells, new = Pflichtmodell der neuen Version */
    kind: z.enum(['update', 'new'])
  })
  .superRefine(refineLayout)

export type BundleModel = z.infer<typeof BundleModelSchema>
