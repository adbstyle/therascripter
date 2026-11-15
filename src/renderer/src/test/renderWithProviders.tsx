import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Route } from '../navigation/routes'
import { AllProviders } from './AllProviders'

interface Options {
  /** Startseite des Verlaufs (Standard: Sitzungsliste). */
  route?: Route
}

export function renderWithProviders(ui: ReactElement, options: Options = {}): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => <AllProviders route={options.route}>{children}</AllProviders>
  })
}
