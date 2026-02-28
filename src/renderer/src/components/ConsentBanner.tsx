import { useCallback, useEffect, useState } from 'react'

export function ConsentBanner(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  useEffect(() => {
    window.api.settings.get('consentReminderShown').then((shown) => {
      if (!shown) setVisible(true)
    })
  }, [])

  const dismiss = useCallback(() => {
    setVisible(false)
    if (dontShowAgain) {
      window.api.settings.set('consentReminderShown', true)
    }
  }, [dontShowAgain])

  if (!visible) return null

  return (
    <div className="mx-6 mt-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg text-warning" aria-hidden="true">
          &#9888;
        </span>
        <div className="flex-1">
          <p className="text-sm text-warning-text">
            Bitte stellen Sie sicher, dass die aufgenommene Person der Aufnahme zugestimmt hat (StGB
            Art. 179bis).
          </p>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              className="titlebar-no-drag h-4 w-4 rounded border-border-strong"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            <span className="text-xs text-warning-text-secondary">Nicht mehr anzeigen</span>
          </label>
        </div>
        <button
          onClick={dismiss}
          className="titlebar-no-drag rounded p-1 text-warning-text-secondary transition-colors hover:text-warning-text"
          aria-label="Hinweis schliessen"
        >
          &#10005;
        </button>
      </div>
    </div>
  )
}
