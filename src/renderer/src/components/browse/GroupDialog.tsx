import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { TabGroup } from '@shared/models'
import { ApiError } from '../../lib/api'
import { useTabGroups } from '../../stores/tabGroupStore'
import { useTopics } from '../../stores/topicStore'
import { Button, Input } from '../common/ui'
import { Dialog } from '../common/Dialog'

/**
 * One dialog for both flows: saving the currently open tabs as a new group,
 * and editing an existing group's name/topics — they're the same shape (a
 * name plus a topic list), so there is no reason to duplicate the form.
 */
export function GroupDialog({
  open,
  onOpenChange,
  clusterId,
  editing,
  initialTopics
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  /** Null when saving the current tabs as a brand new group. */
  editing: TabGroup | null
  /** Only used when `editing` is null — the topics of the tabs open right now. */
  initialTopics: string[]
}): ReactNode {
  const save = useTabGroups((s) => s.save)
  const topics = useTopics((s) => s.topics)

  const [name, setName] = useState('')
  const [groupTopics, setGroupTopics] = useState<string[]>([])
  const [newTopic, setNewTopic] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setGroupTopics(editing?.topics ?? initialTopics)
    setNewTopic('')
    setError(null)
  }, [open, editing, initialTopics])

  const addTopic = (): void => {
    const topic = newTopic.trim()
    if (!topic || groupTopics.includes(topic)) return
    setGroupTopics((t) => [...t, topic])
    setNewTopic('')
  }

  const removeTopic = (topic: string): void => {
    setGroupTopics((t) => t.filter((x) => x !== topic))
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await save(clusterId, name, groupTopics, editing?.id)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the group.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : 'Save tabs as group'}
      description="Opening a group later adds a tab for each topic that isn't already open."
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !name.trim() || groupTopics.length === 0}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save group'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-[var(--text-secondary)]">Name</span>
          <Input
            autoFocus
            value={name}
            placeholder="checkout-feature"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--text-secondary)]">
            Topics ({groupTopics.length})
          </span>
          {groupTopics.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">No topics yet — add one below.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {groupTopics.map((topic) => (
                <li
                  key={topic}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1"
                >
                  <span className="num min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                    {topic}
                  </span>
                  <button
                    aria-label={`Remove ${topic}`}
                    onClick={() => removeTopic(topic)}
                    className="shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-1.5">
            <input
              list="klarity-group-topics"
              value={newTopic}
              placeholder="Add a topic…"
              spellCheck={false}
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTopic()
                }
              }}
              className="h-8 w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
            />
            <datalist id="klarity-group-topics">
              {topics.map((t) => (
                <option key={t.name} value={t.name} />
              ))}
            </datalist>
            <Button size="sm" onClick={addTopic} disabled={!newTopic.trim()}>
              Add
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
