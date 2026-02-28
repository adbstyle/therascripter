import { useCallback, useEffect, useState } from 'react'
import type { BlocklistEntry, PlaceholderType } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { BlocklistDialog } from './BlocklistDialog'

const PLACEHOLDER_TYPE_LABELS: Record<PlaceholderType, string> = {
  PERSON: 'Person',
  ORT: 'Ort',
  DATUM: 'Datum',
  KONTAKT: 'Kontakt',
  ORGANISATION: 'Organisation',
  MEDIZINISCH: 'Medizinisch',
  SONSTIGES: 'Sonstiges'
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
}

type DialogMode = null | { type: 'add' } | { type: 'edit'; entry: BlocklistEntry }

export default function BlocklistManager(): React.JSX.Element {
  const [entries, setEntries] = useState<BlocklistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogMode, setDialogMode] = useState<DialogMode>(null)
  const [deleteTarget, setDeleteTarget] = useState<BlocklistEntry | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const result = await window.api.blocklist.list()
      setEntries(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sperrliste konnte nicht geladen werden')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = useCallback(async (term: string, placeholderType: PlaceholderType) => {
    try {
      const newEntry = await window.api.blocklist.add(term, placeholderType)
      setEntries((prev) => [...prev, newEntry])
      setDialogMode(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eintrag konnte nicht hinzugefügt werden')
    }
  }, [])

  const handleEdit = useCallback(
    async (term: string, placeholderType: PlaceholderType) => {
      if (!dialogMode || dialogMode.type !== 'edit') return
      try {
        const updated = await window.api.blocklist.update(
          dialogMode.entry.id,
          term,
          placeholderType
        )
        if (updated) {
          setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
        }
        setDialogMode(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Eintrag konnte nicht aktualisiert werden')
      }
    },
    [dialogMode]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      const success = await window.api.blocklist.delete(deleteTarget.id)
      if (success) {
        setEntries((prev) => prev.filter((e) => e.id !== deleteTarget.id))
      }
      setDeleteTarget(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eintrag konnte nicht gelöscht werden')
    }
  }, [deleteTarget])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-tertiary">Laden...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-error-text">{error}</p>
      </div>
    )
  }

  return (
    <>
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-text-secondary">
            Begriffe, die immer automatisch anonymisiert werden.
          </p>
          <button
            className="titlebar-no-drag rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
            onClick={() => setDialogMode({ type: 'add' })}
          >
            + Eintrag hinzufügen
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface-1 p-8 text-center">
            <p className="text-sm text-text-tertiary">Noch keine Einträge vorhanden.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="bg-surface-1">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">
                    Begriff
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">
                    Typ
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">
                    Erstellt
                  </th>
                  <th className="w-24 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface-0">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-surface-1">
                    <td className="px-4 py-3 text-sm text-text-primary">{entry.term}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {PLACEHOLDER_TYPE_LABELS[entry.placeholderType]}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-tertiary">
                      {formatDate(entry.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          className="text-sm text-primary hover:text-primary-hover"
                          onClick={() => setDialogMode({ type: 'edit', entry })}
                        >
                          Bearbeiten
                        </button>
                        <button
                          className="text-sm text-error-text hover:text-error-text-emphasis"
                          onClick={() => setDeleteTarget(entry)}
                        >
                          Löschen
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-text-tertiary">{entries.length} Einträge</p>
      </div>

      {dialogMode && (
        <BlocklistDialog
          mode={dialogMode.type}
          initialTerm={dialogMode.type === 'edit' ? dialogMode.entry.term : undefined}
          initialType={dialogMode.type === 'edit' ? dialogMode.entry.placeholderType : undefined}
          onConfirm={dialogMode.type === 'add' ? handleAdd : handleEdit}
          onCancel={() => setDialogMode(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Eintrag löschen"
          message={`\u201e${deleteTarget.term}\u201c aus der Sperrliste entfernen?`}
          confirmLabel="Löschen"
          destructive
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  )
}
