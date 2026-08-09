import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/**
 * Resolve the Python sidecar binary and script path.
 *
 * Resolution order:
 * 1. Production (app.isPackaged): standalone Python in extraResources
 * 2. Dev mit THERASCRIPT_USE_STANDALONE=1: standalone (der Interpreter, den User bekommen)
 * 3. Dev: venv at python_sidecar/venv/
 * 4. Dev: standalone at python_sidecar/standalone/
 * 5. Throw with clear setup instructions
 */
export function resolvePythonSidecar(scriptName: string): { bin: string; args: string[] } {
  if (app.isPackaged) {
    const python = join(process.resourcesPath, 'ml_sidecar', 'standalone', 'bin', 'python3')
    const script = join(process.resourcesPath, 'ml_sidecar', scriptName)
    return { bin: python, args: [script] }
  }

  const appPath = app.getAppPath()
  const script = join(appPath, 'python_sidecar', scriptName)
  const standalonePythonPath = join(appPath, 'python_sidecar', 'standalone', 'bin', 'python3')

  // 0. Opt-in: THERASCRIPT_USE_STANDALONE=1 npm run dev exerziert exakt den
  // Interpreter, den Endnutzer bekommen (venv maskiert sonst Prune-Fehler
  // im Standalone-Build).
  if (process.env.THERASCRIPT_USE_STANDALONE === '1' && existsSync(standalonePythonPath)) {
    return { bin: standalonePythonPath, args: [script] }
  }

  // 1. Prefer venv (standard dev setup)
  const venvPython = join(appPath, 'python_sidecar', 'venv', 'bin', 'python3')
  if (existsSync(venvPython)) {
    return { bin: venvPython, args: [script] }
  }

  // 2. Fall back to standalone build
  const standalonePython = join(appPath, 'python_sidecar', 'standalone', 'bin', 'python3')
  if (existsSync(standalonePython)) {
    return { bin: standalonePython, args: [script] }
  }

  throw new Error(
    `Python-Sidecar nicht gefunden. Bitte führen Sie scripts/setup-pyannote.sh und scripts/setup-ner.sh aus.`
  )
}
