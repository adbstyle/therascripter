import { ViewModeToggle } from './ViewModeToggle'

export default function TitleBar(): React.JSX.Element {
  return (
    <div
      className="titlebar-drag relative flex h-9 shrink-0 select-none items-center justify-center bg-surface-0"
      role="banner"
      aria-label="TheraScript"
    >
      <span className="text-sm font-semibold tracking-tight text-text-primary" aria-hidden>
        TheraScript
      </span>
      {/* Issue #203 — Ansicht, von überall erreichbar */}
      <div className="absolute inset-y-0 right-3 flex items-center">
        <ViewModeToggle />
      </div>
    </div>
  )
}
