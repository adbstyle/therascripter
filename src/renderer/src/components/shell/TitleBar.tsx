export default function TitleBar(): React.JSX.Element {
  return (
    <div
      className="titlebar-drag flex h-9 shrink-0 select-none items-center justify-center bg-surface-0"
      role="banner"
      aria-label="TheraScript"
    >
      <span className="text-sm font-semibold tracking-tight text-text-primary" aria-hidden>
        TheraScript
      </span>
    </div>
  )
}
