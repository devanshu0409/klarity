import type { ReactNode } from 'react'
import { Construction } from 'lucide-react'
import { EmptyState } from '../common/ui'

/**
 * Stand-in for a section whose phase has not landed. Names the phase so the
 * shell is navigable end to end without pretending the feature exists.
 */
export function SectionPlaceholder({
  title,
  phase,
  summary
}: {
  title: string
  phase: string
  summary: string
}): ReactNode {
  return (
    <EmptyState
      icon={<Construction size={28} strokeWidth={1.5} />}
      title={title}
      hint={`${summary} — arrives in ${phase}.`}
    />
  )
}
