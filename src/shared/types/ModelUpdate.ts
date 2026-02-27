export interface ManifestModel {
  id: string
  version: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
}

export interface Manifest {
  generatedAt: string
  models: ManifestModel[]
}

export interface PendingModelUpdate {
  id: string
  version: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
  // Structural info from MODEL_DEFINITIONS (needed for executeUpdates without re-fetching)
  relativePath: string
  archive?: boolean
  checkPath: string
}

export interface InstalledModelVersion {
  version: string
  sha256: string
  installedAt: string
}
