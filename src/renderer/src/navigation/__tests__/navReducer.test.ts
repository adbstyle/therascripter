import { describe, it, expect } from 'vitest'
import {
  initialNavState,
  MAX_HISTORY,
  navReducer,
  type NavAction,
  type NavState
} from '../navReducer'
import { routeKey, sameRoute, type Route } from '../routes'

const sessions: Route = { kind: 'sessions' }
const session = (id: string): Route => ({ kind: 'session', sessionId: id })
const settings = (subpage: 'updates' | null = null): Route => ({ kind: 'settings', subpage })
const dossier = (id: string): Route => ({ kind: 'dossier', dossierId: id })

function run(state: NavState, ...actions: NavAction[]): NavState {
  return actions.reduce(navReducer, state)
}
const go = (
  route: Route,
  options?: { anchorId?: string; replace?: boolean; targetAnchorId?: string }
): NavAction => ({
  type: 'navigate',
  route,
  options
})
const keys = (entries: { route: Route }[]): string[] => entries.map((e) => routeKey(e.route))

describe('routes', () => {
  it('unterscheidet Seiten, nicht die Stelle in einer Sitzung', () => {
    expect(
      sameRoute(session('a'), { kind: 'session', sessionId: 'a', focus: { kind: 'title' } })
    ).toBe(true)
    expect(sameRoute(session('a'), session('b'))).toBe(false)
    expect(sameRoute(settings(null), settings('updates'))).toBe(false)
  })
})

describe('navReducer', () => {
  it('startet auf der Sitzungsliste ohne Verlauf', () => {
    const state = initialNavState()
    expect(state.current.route).toEqual(sessions)
    expect(state.back).toEqual([])
    expect(state.forward).toEqual([])
  })

  it('legt beim Navigieren einen Eintrag an und geht zurück und vorwärts', () => {
    let state = run(initialNavState(), go(session('a')), go(settings()))
    expect(keys(state.back)).toEqual(['sessions', 'session:a'])

    state = navReducer(state, { type: 'back' })
    expect(state.current.route).toEqual(session('a'))
    expect(keys(state.forward)).toEqual(['settings:'])

    state = navReducer(state, { type: 'back' })
    expect(state.current.route).toEqual(sessions)

    state = navReducer(state, { type: 'forward' })
    state = navReducer(state, { type: 'forward' })
    expect(state.current.route).toEqual(settings())
    expect(state.forward).toEqual([])
  })

  it('behält beim Zurückgehen die Eintrags-ID (Scroll-Position bleibt zuordenbar)', () => {
    const start = initialNavState()
    const state = run(start, go(session('a')), { type: 'back' })
    expect(state.current.id).toBe(start.current.id)
  })

  it('legt für dieselbe Seite keinen zweiten Eintrag an', () => {
    const state = run(initialNavState(), go(session('a')), go(session('a')))
    expect(keys(state.back)).toEqual(['sessions'])
  })

  it('übernimmt eine andere Stelle derselben Sitzung im aktuellen Eintrag', () => {
    const before = run(initialNavState(), go(session('a')))
    const focused: Route = {
      kind: 'session',
      sessionId: 'a',
      focus: { kind: 'paragraph', index: 3 }
    }
    const after = navReducer(before, go(focused))
    expect(after.current.route).toEqual(focused)
    expect(after.current.id).toBe(before.current.id)
    expect(after.back).toHaveLength(1)
  })

  it('verwirft den Vorwärts-Verlauf bei einer neuen Navigation', () => {
    const state = run(initialNavState(), go(session('a')), { type: 'back' }, go(settings()))
    expect(state.forward).toEqual([])
    expect(keys(state.back)).toEqual(['sessions'])
  })

  it(`begrenzt den Verlauf auf ${MAX_HISTORY} Einträge`, () => {
    let state = initialNavState()
    for (let i = 0; i < 80; i++) state = navReducer(state, go(session(`s${i}`)))
    expect(state.back.length + 1).toBe(MAX_HISTORY)
    expect(state.current.route).toEqual(session('s79'))
    expect(state.back[0].route).toEqual(session(`s${80 - MAX_HISTORY}`))
  })

  it('setzt targetAnchorId auf den NEUEN Eintrag (#213: Karte auf der Zielseite markieren)', () => {
    const state = run(initialNavState(dossier('d1')), go(sessions, { targetAnchorId: 's9' }))
    expect(state.current).toMatchObject({ route: sessions, anchorId: 's9' })
    expect(state.back[0].anchorId).toBeUndefined()
  })

  it('baut mit targetAnchorId dieselbe Seite neu auf, ohne zweiten Eintrag', () => {
    const start = run(initialNavState(), go(session('a')), go(sessions))
    const state = run(start, go(sessions, { targetAnchorId: 's9' }))
    expect(state.current.id).not.toBe(start.current.id)
    expect(state.current.anchorId).toBe('s9')
    expect(keys(state.back)).toEqual(keys(start.back))
  })

  it('schreibt anchorId auf den Herkunftseintrag', () => {
    let state = run(initialNavState(), go(session('a'), { anchorId: 'a' }))
    expect(state.current.anchorId).toBeUndefined()
    expect(state.back[0].anchorId).toBe('a')

    state = navReducer(state, { type: 'back' })
    expect(state.current.route).toEqual(sessions)
    expect(state.current.anchorId).toBe('a')
  })

  it('ersetzt mit replace den aktuellen Eintrag', () => {
    const state = run(initialNavState(), go(session('a')), go(settings(), { replace: true }))
    expect(keys(state.back)).toEqual(['sessions'])
    expect(state.current.route).toEqual(settings())
  })

  it('tut am Anfang und Ende des Verlaufs nichts', () => {
    const start = initialNavState()
    expect(navReducer(start, { type: 'back' })).toBe(start)
    expect(navReducer(start, { type: 'forward' })).toBe(start)
  })

  it('geht ohne Verlauf zum Fallback zurück', () => {
    const start = initialNavState(session('a'))
    const state = navReducer(start, { type: 'back', fallback: sessions })
    expect(state.current.route).toEqual(sessions)
    expect(keys(state.forward)).toEqual(['session:a'])
  })

  it('geht mit fromEntryId nur zurück, wenn der Eintrag noch aktuell ist', () => {
    const state = run(initialNavState(), go(session('a')))
    const stale = navReducer(state, { type: 'back', fromEntryId: state.current.id - 1 })
    expect(stale).toBe(state)
    const fresh = navReducer(state, { type: 'back', fromEntryId: state.current.id })
    expect(fresh.current.route).toEqual(sessions)
  })

  it('überspringt ungültige Einträge', () => {
    const state = run(initialNavState(), go(session('a')), go(session('b')), go(settings()))
    const isValid = (route: Route): boolean => !sameRoute(route, session('b'))
    const back = navReducer(state, { type: 'back', isValid })
    expect(back.current.route).toEqual(session('a'))
    const forward = navReducer(run(back, { type: 'back' }), { type: 'forward', isValid })
    expect(forward.current.route).toEqual(session('a'))
  })

  describe('purge (#213 PC 3)', () => {
    const deleted = (id: string) => (route: Route) =>
      route.kind === 'session' && route.sessionId === id

    it('entfernt gelöschte Sitzungen aus Zurück und Vorwärts', () => {
      let state = run(initialNavState(), go(session('a')), go(settings()), go(session('b')))
      state = run(state, { type: 'back' }, { type: 'back' })
      expect(state.current.route).toEqual(session('a'))
      state = navReducer(state, {
        type: 'purge',
        predicate: (r) => deleted('a')(r) || deleted('b')(r)
      })
      expect(keys(state.back)).toEqual([])
      expect(state.current.route).toEqual(sessions)
      expect(keys(state.forward)).toEqual(['settings:'])
    })

    it('ersetzt eine gelöschte aktuelle Sitzung durch den vorherigen Eintrag', () => {
      let state = run(initialNavState(), go(settings()), go(session('a')))
      state = navReducer(state, { type: 'purge', predicate: deleted('a') })
      expect(state.current.route).toEqual(settings())
      expect(keys(state.back)).toEqual(['sessions'])
      expect(state.forward).toEqual([])
    })

    it('ersetzt ein gelöschtes aktuelles Dossier durch die Übersicht', () => {
      let state = run(initialNavState(), go(dossier('d1')))
      state = navReducer(state, {
        type: 'purge',
        predicate: (r) => r.kind === 'dossier' && r.dossierId === 'd1'
      })
      expect(state.current.route).toEqual({ kind: 'dossiers' })
      expect(keys(state.back)).toEqual(['sessions'])
    })

    it('fällt ohne Verlauf auf die Startseite zurück', () => {
      const state = navReducer(initialNavState(session('a')), {
        type: 'purge',
        predicate: deleted('a')
      })
      expect(state.current.route).toEqual(sessions)
    })

    it('fasst nach dem Entfernen gleiche Nachbarn zusammen', () => {
      let state = run(initialNavState(), go(session('a')), go(sessions), go(session('b')))
      state = navReducer(state, { type: 'purge', predicate: deleted('a') })
      expect(keys(state.back)).toEqual(['sessions'])
    })

    it('ändert nichts, wenn nichts betroffen ist', () => {
      const state = run(initialNavState(), go(session('a')))
      expect(navReducer(state, { type: 'purge', predicate: deleted('x') })).toBe(state)
    })
  })

  it('verwirft den Anker eines Eintrags, sobald er eingelöst ist', () => {
    let state = run(initialNavState(), go(session('a'), { anchorId: 'a' }), { type: 'back' })
    expect(state.current.anchorId).toBe('a')
    expect(navReducer(state, { type: 'consumeAnchor', entryId: state.current.id + 99 })).toBe(state)
    state = navReducer(state, { type: 'consumeAnchor', entryId: state.current.id })
    expect(state.current.anchorId).toBeUndefined()
  })

  it('lässt nach purge keinen Vorwärts-Eintrag der aktuellen Seite stehen', () => {
    // Liste → A → (Seitenleiste) Liste → ‹ → A löschen
    let state = run(initialNavState(), go(session('a')), go(sessions), { type: 'back' })
    expect(state.current.route).toEqual(session('a'))
    state = navReducer(state, {
      type: 'purge',
      predicate: (r) => r.kind === 'session' && r.sessionId === 'a'
    })
    expect(state.current.route).toEqual(sessions)
    expect(state.forward).toEqual([])
    expect(state.back).toEqual([])
  })
})

describe('Dossier löschen: Übersicht steht nicht doppelt im Verlauf (Review #219)', () => {
  const dossiers: Route = { kind: 'dossiers' }
  const purgeD1: NavAction = {
    type: 'purge',
    predicate: (route) => route.kind === 'dossier' && route.dossierId === 'd1'
  }
  const start = (): NavState => run(initialNavState(), go(dossiers), go(dossier('d1')))

  it('erst die IPC-Antwort (replace), dann dossiers:changed (purge)', () => {
    const state = run(start(), go(dossiers, { replace: true }), purgeD1)
    expect(keys(state.back)).toEqual(['sessions'])
    expect(routeKey(state.current.route)).toBe('dossiers')
    expect(state.forward).toEqual([])
  })

  it('erst dossiers:changed (purge), dann die IPC-Antwort (replace)', () => {
    const state = run(start(), purgeD1, go(dossiers, { replace: true }))
    expect(keys(state.back)).toEqual(['sessions'])
    expect(routeKey(state.current.route)).toBe('dossiers')
  })

  it('replace legt auch vorwärts gleiche Nachbarn zusammen', () => {
    let state = run(initialNavState(), go(dossiers), go(dossier('d1')), go(dossiers))
    state = navReducer(state, { type: 'back' })
    expect(routeKey(state.current.route)).toBe('dossier:d1')
    state = navReducer(state, go(dossiers, { replace: true }))
    expect(keys(state.back)).toEqual(['sessions'])
    expect(state.forward).toEqual([])
  })
})
