import { useEffect, useState, type ReactNode } from 'react'
import { Download, HardDrive, Plug } from 'lucide-react'
import type { BrokerInfo, ConfigEntry } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { ApiError, call } from '../../lib/api'
import { formatNumber } from '../../lib/format'
import { Badge, Button, EmptyState, Input, Panel } from '../common/ui'
import { DataTable, type Column } from '../common/DataTable'

export function BrokersView(): ReactNode {
  const clusterId = useClusters((s) => s.selectedId)
  const connected = useClusters((s) =>
    s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false
  )

  const [brokers, setBrokers] = useState<BrokerInfo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [configs, setConfigs] = useState<ConfigEntry[]>([])
  const [configFilter, setConfigFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listCollapsed, setListCollapsed] = useState(false)

  useEffect(() => {
    if (!clusterId || !connected) {
      setBrokers([])
      setSelected(null)
      return
    }
    setLoading(true)
    setError(null)
    call('brokers:list', clusterId)
      .then((list) => {
        setBrokers(list)
        setSelected((current) => current ?? list[0]?.nodeId ?? null)
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not list brokers.')
      )
      .finally(() => setLoading(false))
  }, [clusterId, connected])

  useEffect(() => {
    if (!clusterId || selected === null) {
      setConfigs([])
      return
    }
    let cancelled = false
    call('brokers:describeConfigs', clusterId, selected)
      .then((entries) => {
        if (!cancelled) setConfigs(entries)
      })
      .catch(() => {
        // Broker configs are commonly ACL-restricted; an empty pane with the
        // table's own empty state says enough.
        if (!cancelled) setConfigs([])
      })
    return () => {
      cancelled = true
    }
  }, [clusterId, selected])

  if (!clusterId || !connected) {
    return (
      <EmptyState
        icon={<Plug size={28} strokeWidth={1.5} />}
        title="Not connected"
        hint="Connect to a cluster to inspect its brokers."
      />
    )
  }

  const brokerColumns: Column<BrokerInfo>[] = [
    {
      key: 'id',
      header: 'ID',
      width: '60px',
      align: 'right',
      render: (b) => <span className="num">{b.nodeId}</span>
    },
    {
      key: 'host',
      header: 'Host',
      render: (b) => (
        <span className="flex items-center gap-1.5">
          <span className="num truncate">
            {b.host}:{b.port}
          </span>
          {b.isController && <Badge color="json">controller</Badge>}
        </span>
      )
    },
    {
      key: 'rack',
      header: 'Rack',
      width: '90px',
      render: (b) => <span className="num">{b.rack ?? '—'}</span>
    },
    {
      key: 'leaders',
      header: 'Leader parts',
      width: '110px',
      align: 'right',
      render: (b) => (
        <span className="num">
          {b.leaderPartitionCount === undefined ? '—' : formatNumber(b.leaderPartitionCount)}
        </span>
      )
    }
  ]

  const needle = configFilter.trim().toLowerCase()
  const visibleConfigs = needle
    ? configs.filter(
        (c) => c.name.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle)
      )
    : configs

  const configColumns: Column<ConfigEntry>[] = [
    {
      key: 'name',
      header: 'Config',
      width: '45%',
      render: (c) => (
        <span className="flex items-center gap-1.5">
          <span className="num truncate">{c.name}</span>
          {!c.isDefault && <Badge color="json">set</Badge>}
          {c.isReadOnly && <Badge color="raw">ro</Badge>}
        </span>
      )
    },
    { key: 'value', header: 'Value', render: (c) => <span className="num truncate">{c.value}</span> }
  ]

  return (
    <div
      className="grid h-full gap-3 p-3"
      style={{ gridTemplateRows: `${listCollapsed ? 'auto' : 'minmax(140px, 32%)'} 1fr` }}
    >
      <Panel
        title={`Brokers (${brokers.length})`}
        collapsible
        collapsed={listCollapsed}
        onCollapsedChange={setListCollapsed}
      >
        {error ? (
          <EmptyState title="Could not load brokers" hint={error} />
        ) : loading ? (
          <EmptyState title="Loading brokers…" />
        ) : (
          <DataTable
            rows={brokers}
            columns={brokerColumns}
            rowKey={(b) => String(b.nodeId)}
            selectedKey={selected === null ? null : String(selected)}
            onRowClick={(b) => setSelected(b.nodeId)}
          />
        )}
      </Panel>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <HardDrive size={13} />
            {selected === null ? 'Broker configuration' : `Broker ${selected} configuration`}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={configFilter}
              placeholder="Filter configs…"
              className="h-7 w-56"
              onChange={(e) => setConfigFilter(e.target.value)}
            />
            <Button
              size="sm"
              disabled={configs.length === 0}
              onClick={() =>
                void call('export:rows', {
                  suggestedName: `broker-${selected}-config`,
                  format: 'csv',
                  rows: configs.map((c) => ({
                    name: c.name,
                    value: c.value,
                    isDefault: c.isDefault,
                    readOnly: c.isReadOnly
                  }))
                })
              }
            >
              <Download size={13} /> Export
            </Button>
          </div>
        }
      >
        <DataTable
          rows={visibleConfigs}
          columns={configColumns}
          rowKey={(c) => c.name}
          empty={
            <EmptyState
              title="No configuration to show"
              hint="Kafka often restricts describeConfigs on brokers to superusers."
            />
          }
        />
      </Panel>
    </div>
  )
}
