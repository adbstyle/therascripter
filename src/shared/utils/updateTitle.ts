/**
 * «Version 1.2.0» bzw. «Modell-Update» (#167: ein Update kann nur Modelle
 * enthalten) — eine Stelle für Einstellungen und Menüleiste.
 */
export function updateTitle(update: { version: string | null }): string {
  return update.version ? `Version ${update.version}` : 'Modell-Update'
}
