import { useEffect, useRef, useState } from 'react'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import RecordingBar from './RecordingBar'
import RouteView from './RouteView'
import { PageScroll } from './PageScroll'
import MicrophoneBanner from '../MicrophoneBanner'
import ToolsBlockedBanner from '../ToolsBlockedBanner'
import { useNavigation } from '../../navigation/navigation'
import { useRecordingState } from '../../contexts/recording'
import { useToolHealth } from '../../hooks/useToolHealth'
import { useSidebarOpen } from '../../hooks/useSidebarOpen'
import { pruneScrollPositions } from '../../navigation/useScrollRestoration'

/**
 * App-Shell (Epic #192): Titelleiste über der ganzen Breite, darunter
 * Seitenleiste und Inhaltsspalte. Die Inhaltsspalte trägt die Hinweise, die
 * Aufnahme-Leiste und den einzigen Scroll-Container. Jedes Glied der
 * Flex-Kette bis zum Scroll-Container braucht `min-h-0`, sonst wächst der
 * Inhalt über das Fenster hinaus, statt zu scrollen.
 */
export default function AppShell(): React.JSX.Element {
  const { route, entryId, anchorId, entryIds, navigate, consumeAnchor } = useNavigation()
  const { isRecording, duration, microphone } = useRecordingState()
  const toolHealth = useToolHealth()
  const { sidebarOpen, toggleSidebar } = useSidebarOpen()
  // Pro App-Lauf ausgeblendet; nach dem nächsten Start kommt der Hinweis wieder
  const [toolsHintDismissed, setToolsHintDismissed] = useState(false)
  const scrollPositions = useRef(new Map<number, number>())
  // Verworfene Verlaufseinträge (Limit, neuer Zweig, purge) brauchen keine Position mehr
  const liveIds = entryIds.join(',')
  useEffect(() => {
    pruneScrollPositions(
      scrollPositions.current,
      liveIds.split(',').map((id) => Number(id))
    )
  }, [liveIds])

  // Auf der Sitzungsliste zeigt die Live-Karte die Aufnahme — keine Leiste doppelt
  const showRecordingBar = isRecording && route.kind !== 'sessions'

  return (
    <div className="flex h-screen flex-col bg-surface-0">
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Von macOS blockierte Werkzeuge (Issue #168) — nie während einer Aufnahme */}
          {toolHealth.state?.status === 'blocked' && !toolsHintDismissed && !isRecording && (
            <ToolsBlockedBanner
              state={toolHealth.state}
              checking={toolHealth.checking}
              onOpenGuide={toolHealth.openGuide}
              onRecheck={() => void toolHealth.recheck()}
              onDismiss={() => setToolsHintDismissed(true)}
            />
          )}

          {/* Mikrofon-Berechtigung (Issue #161) — nie während einer Aufnahme */}
          {microphone.hint && !isRecording && (
            <MicrophoneBanner
              variant={microphone.hint}
              onAllow={microphone.allow}
              onOpenSettings={microphone.openSettings}
              onDismiss={microphone.dismiss}
            />
          )}

          {showRecordingBar && (
            <RecordingBar
              duration={duration}
              onOpenRecording={() => navigate({ kind: 'sessions' })}
            />
          )}

          <PageScroll
            key={entryId}
            entryId={entryId}
            anchorId={anchorId}
            positions={scrollPositions.current}
            onAnchorConsumed={consumeAnchor}
          >
            <RouteView />
          </PageScroll>
        </div>
      </div>
    </div>
  )
}
