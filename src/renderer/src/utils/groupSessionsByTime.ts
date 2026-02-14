import type { Session } from '../../../shared/types'

export type TimeGroup = 'Heute' | 'Gestern' | 'Diese Woche' | 'Letzte Woche' | 'Älter'

export const GROUP_ORDER: TimeGroup[] = [
  'Heute',
  'Gestern',
  'Diese Woche',
  'Letzte Woche',
  'Älter'
]

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date)
  const day = d.getDay()
  // Monday = 1, Sunday = 0 → shift so Monday is start
  const diff = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diff)
  return d
}

export function groupSessionsByTime(sessions: Session[]): Map<TimeGroup, Session[]> {
  const now = new Date()
  const today = startOfDay(now)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  const groups = new Map<TimeGroup, Session[]>()

  for (const session of sessions) {
    const created = new Date(session.createdAt)
    let group: TimeGroup

    if (created >= today) {
      group = 'Heute'
    } else if (created >= yesterday) {
      group = 'Gestern'
    } else if (created >= thisWeekStart) {
      group = 'Diese Woche'
    } else if (created >= lastWeekStart) {
      group = 'Letzte Woche'
    } else {
      group = 'Älter'
    }

    const existing = groups.get(group) ?? []
    existing.push(session)
    groups.set(group, existing)
  }

  return groups
}
