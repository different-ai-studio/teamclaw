import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'

export const PluginSection = React.memo(function PluginSection() {
  const { t } = useTranslation()
  const [plugins, setPlugins] = React.useState([
    { name: 'Git Integration', version: '1.0.0', enabled: true, icon: '🔀' },
    { name: 'Docker Support', version: '0.9.0', enabled: false, icon: '🐳' },
    { name: 'Database Tools', version: '1.2.0', enabled: true, icon: '🗄️' },
  ])

  const togglePlugin = (index: number) => {
    setPlugins(prev => prev.map((p, i) => 
      i === index ? { ...p, enabled: !p.enabled } : p
    ))
  }

  return (
    <div className="space-y-6">
      <SectionHeader 
        icon={Puzzle} 
        title={t('settings.plugins.title', 'Plugins')} 
        description={t('settings.plugins.description', 'Extend functionality with plugins')}
        iconColor="text-pink-500"
      />
      
      <div className="space-y-3">
        {plugins.map((plugin, index) => (
          <SettingCard 
            key={plugin.name}
            className={cn(
              "transition-all",
              plugin.enabled ? "border-primary/30 bg-primary/5" : ""
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="text-2xl">{plugin.icon}</div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{plugin.name}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      v{plugin.version}
                    </span>
                  </div>
                </div>
              </div>
              <ToggleSwitch enabled={plugin.enabled} onChange={() => togglePlugin(index)} />
            </div>
          </SettingCard>
        ))}
      </div>

      <Button variant="outline" className="w-full h-11 gap-2 border-dashed">
        <Plus className="h-4 w-4" />
        {t('settings.plugins.browse', 'Browse Plugins')}
      </Button>
    </div>
  )
})
