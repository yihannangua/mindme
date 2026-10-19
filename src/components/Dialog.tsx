import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
export function Dialog({
  title,
  close,
  children,
  wide = false,
}: {
  title: string
  close: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog
      className={wide ? 'dialog wide' : 'dialog'}
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
