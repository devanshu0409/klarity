import { useEffect, useState, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useUi, type Section } from './stores/uiStore'
import { useClusters } from './stores/clusterStore'
import { IconRail } from './components/shell/IconRail'
import { StatusBar, TopBar } from './components/shell/TopBar'
import { SectionPlaceholder } from './components/shell/SectionPlaceholder'
import { SettingsView } from './components/SettingsView'
import { ClustersView } from './components/clusters/ClustersView'
import { ClusterDialog } from './components/clusters/ClusterDialog'
import { BrokersView } from './components/brokers/BrokersView'
import { BrowseView } from './components/browse/BrowseView'
import { GroupsView } from './components/groups/GroupsView'
import { ProduceView } from './components/produce/ProduceView'

const PLACEHOLDERS: Record<
  Extract<Section, 'loadtest'>,
  { title: string; phase: string; summary: string }
> = {
  loadtest: {
    title: 'Load test',
    phase: 'Phase 5',
    summary: 'Templated production with field mutators, then verify consumption'
  }
}

export default function App(): ReactNode {
  const section = useUi((s) => s.section)
  const initUi = useUi((s) => s.init)
  const settingsLoaded = useUi((s) => s.settingsLoaded)

  const loadClusters = useClusters((s) => s.load)
  const watchClusters = useClusters((s) => s.watch)

  // Owned here so the top bar's "Add cluster…" item can open the same dialog
  // the clusters view uses.
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    void initUi()
    void loadClusters()
    return watchClusters()
  }, [initUi, loadClusters, watchClusters])

  return (
    <Tooltip.Provider>
      <div className="flex h-full w-full bg-[var(--bg-app)]">
        <IconRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onAddCluster={() => setAddOpen(true)} />
          <main className="min-h-0 flex-1 overflow-hidden">
            {/* Hold the first paint until the persisted theme is applied, so the
                app never flashes light before switching to dark. */}
            {!settingsLoaded ? null : section === 'settings' ? (
              <SettingsView />
            ) : section === 'clusters' ? (
              <ClustersView />
            ) : section === 'brokers' ? (
              <BrokersView />
            ) : section === 'browse' ? (
              <BrowseView />
            ) : section === 'groups' ? (
              <GroupsView />
            ) : section === 'produce' ? (
              <ProduceView />
            ) : (
              <SectionPlaceholder {...PLACEHOLDERS[section]} />
            )}
          </main>
          <StatusBar />
        </div>
      </div>

      <ClusterDialog open={addOpen} onOpenChange={setAddOpen} editing={null} />
    </Tooltip.Provider>
  )
}
