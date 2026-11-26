import type { ReactNode } from 'react'
import { TableVirtuoso } from 'react-virtuoso'
import { cx } from './ui'

export interface Column<T> {
  key: string
  header: ReactNode
  /** Any CSS width; the grid is a plain table so percentages work. */
  width?: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
}

/**
 * Virtualized table. Every list in this app can reach tens of thousands of rows
 * (topics on a big cluster, messages from a scan), so rendering all of them is
 * never an option — see PLAN.md §9 rule 4.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  onRowClick,
  empty
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  selectedKey?: string | null
  onRowClick?: (row: T) => void
  empty?: ReactNode
}): ReactNode {
  if (rows.length === 0 && empty) return <>{empty}</>

  return (
    <TableVirtuoso
      data={rows}
      className="h-full"
      components={{
        Table: (props) => (
          <table {...props} className="w-full border-collapse text-[12px]" />
        ),
        TableRow: (props) => {
          const row = rows[props['data-index']]
          const key = row ? rowKey(row) : undefined
          return (
            <tr
              {...props}
              onClick={row && onRowClick ? () => onRowClick(row) : undefined}
              className={cx(
                'border-b border-[var(--border)]',
                onRowClick && 'cursor-pointer',
                key && key === selectedKey
                  ? 'bg-[var(--accent-subtle)]'
                  : 'hover:bg-[var(--bg-hover)]'
              )}
            />
          )
        }
      }}
      fixedHeaderContent={() => (
        <tr className="bg-[var(--bg-sunken)]">
          {columns.map((col) => (
            <th
              key={col.key}
              style={{ width: col.width }}
              className={cx(
                'border-b border-[var(--border)] px-2.5 py-1.5 text-[11px] font-semibold',
                'tracking-wide text-[var(--text-secondary)] uppercase',
                col.align === 'right' ? 'text-right' : 'text-left'
              )}
            >
              {col.header}
            </th>
          ))}
        </tr>
      )}
      itemContent={(_index, row) =>
        columns.map((col) => (
          <td
            key={col.key}
            style={{ width: col.width }}
            className={cx(
              'truncate px-2.5 text-[var(--text-primary)]',
              col.align === 'right' ? 'text-right' : 'text-left'
            )}
            // Row height is a token so the compact density toggle applies here
            // without every table knowing about it.
          >
            <div style={{ paddingBlock: 'var(--row-padding-y)' }} className="truncate">
              {col.render(row)}
            </div>
          </td>
        ))
      }
    />
  )
}
