import { useState, type ReactNode } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { Button, Input, cx } from './ui'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg'
}): ReactNode {
  const maxWidth = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl' }[width]

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[var(--bg-overlay)]" />
        <RadixDialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[92vw] -translate-x-1/2 -translate-y-1/2',
            'flex-col rounded-[var(--radius-lg)] border border-[var(--border)]',
            'bg-[var(--bg-surface)] shadow-[var(--shadow-lg)]',
            maxWidth
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <RadixDialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                {title}
              </RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={15} />
              </Button>
            </RadixDialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>

          {footer && (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              {footer}
            </footer>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * Destructive-action gate. The user retypes the resource name; the same token
 * is re-checked in the main process, so this dialog is a usability layer over
 * the real guard rather than the guard itself.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmWord,
  confirmLabel = 'Delete',
  busy,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: ReactNode
  /** The exact text the user must type, usually the topic or group name. */
  confirmWord: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: (token: string) => void
}): ReactNode {
  const [typed, setTyped] = useState('')
  const matches = typed === confirmWord

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('')
        onOpenChange(next)
      }}
      title={title}
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!matches || busy}
            onClick={() => onConfirm(typed)}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-subtle)] p-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--danger)]" />
          <div className="text-[12px] text-[var(--text-primary)]">{body}</div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--text-secondary)]">
            Type <code className="num text-[var(--text-primary)]">{confirmWord}</code> to confirm
          </span>
          <Input
            value={typed}
            autoFocus
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmWord}
          />
        </label>
      </div>
    </Dialog>
  )
}
