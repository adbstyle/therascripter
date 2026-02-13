import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import App from '../App'

describe('App', () => {
  it('renders Therascript title', () => {
    render(<App />)
    expect(screen.getByText('THERASCRIPT')).toBeInTheDocument()
  })

  it('shows empty state message', () => {
    render(<App />)
    expect(screen.getByText('Keine Sitzungen')).toBeInTheDocument()
  })
})
