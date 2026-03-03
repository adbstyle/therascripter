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
  latestAppVersion?: string
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

// ─── App Update ──────────────────────────────────────────────────────────────

export interface AppUpdateStatus {
  available: boolean
  checkedAt: string | null // ISO timestamp of last check
}

export interface CheckResult {
  modelUpdates: PendingModelUpdate[]
  appUpdate: AppUpdateStatus
}
