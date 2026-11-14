import type { Session, ViewMode } from '../../../shared/types'

/** Title of a session as the chosen view shows it (#203 AK 4); '' when there is none. */
export function sessionTitleIn(
  session: Pick<Session, 'title' | 'titlePlain'>,
  mode: ViewMode
): string {
  const title = mode === 'plain' ? (session.titlePlain ?? session.title) : session.title
  return title ?? ''
}

/** Summary of a session as the chosen view shows it (#203 AK 4); null when there is none. */
export function sessionSummaryIn(
  session: Pick<Session, 'summary' | 'summaryPlain'>,
  mode: ViewMode
): string | null {
  return mode === 'plain' ? (session.summaryPlain ?? session.summary) : session.summary
}
