export default function TitleBar(): React.JSX.Element {
  return (
    <div
      className="titlebar-drag flex h-9 shrink-0 select-none items-center justify-center bg-surface-0"
      role="banner"
      aria-label="Therascript"
    >
      <span
        className="text-xs font-medium uppercase tracking-[0.2em] text-text-tertiary"
        aria-hidden
      >
        Therascript
      </span>
    </div>
  )
}
