import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
export function Dialog({
  title,
  close,
  children,
  wide = false,
  className,
}: {
  title: string
  close: () => void
  children: ReactNode
  wide?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previousFocus = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <dialog
      className={['dialog', wide && 'wide', className].filter(Boolean).join(' ')}
      ref={ref}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const r = ref.current!.getBoundingClientRect()
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            close()
        }
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="关闭对话框" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
