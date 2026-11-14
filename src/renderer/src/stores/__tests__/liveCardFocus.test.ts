import { describe, it, expect } from 'vitest'
import { cancelLiveCardFocus, consumeLiveCardFocus, requestLiveCardFocus } from '../liveCardFocus'

describe('liveCardFocus (Review #225)', () => {
  it('löst einen frischen Auftrag genau einmal ein', () => {
    requestLiveCardFocus(1000)
    expect(consumeLiveCardFocus(2000)).toBe(true)
    expect(consumeLiveCardFocus(2000)).toBe(false)
  })

  it('verfällt nach fünf Sekunden und lässt sich zurücknehmen', () => {
    requestLiveCardFocus(0)
    expect(consumeLiveCardFocus(5001)).toBe(false)
    requestLiveCardFocus(0)
    cancelLiveCardFocus()
    expect(consumeLiveCardFocus(10)).toBe(false)
  })
})
