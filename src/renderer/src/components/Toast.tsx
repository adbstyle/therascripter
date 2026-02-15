import { useEffect, useState } from 'react'

export interface ToastData {
  id: number
  message: string
  type: 'success' | 'error'
}

interface ToastProps {
  toast: ToastData
  onDismiss: (id: number) => void
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true))

    const timer = setTimeout(() => {
      setVisible(false)
      // Remove after fade-out animation
      setTimeout(() => onDismiss(toast.id), 200)
    }, 3000)

    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const bgColor = toast.type === 'success' ? 'bg-gray-800' : 'bg-red-600'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`${bgColor} rounded-lg px-4 py-3 text-sm text-white shadow-lg transition-all duration-200 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-center gap-2">
        {toast.type === 'success' ? (
          <span aria-hidden="true">&#10003;</span>
        ) : (
          <span aria-hidden="true">&#10007;</span>
        )}
        <span>{toast.message}</span>
      </div>
    </div>
  )
}
