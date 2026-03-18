import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Save,
  RefreshCw,
  AlertCircle,
  GitBranch,
} from 'lucide-react'
import { useGitReposStore } from '@/stores/git-repos'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SettingCard } from './shared'

export const GitReposSection = React.memo(function GitReposSection() {
  const { t } = useTranslation()
  const gitAvailable = useGitReposStore((s) => s.gitAvailable)
  const gitVersion = useGitReposStore((s) => s.gitVersion)
  const repos = useGitReposStore((s) => s.repos)
  const config = useGitReposStore((s) => s.config)
  const initialized = useGitReposStore((s) => s.initialized)
  const syncing = useGitReposStore((s) => s.syncing)
  const initialize = useGitReposStore((s) => s.initialize)
  const syncAll = useGitReposStore((s) => s.syncAll)
  const syncRepo = useGitReposStore((s) => s.syncRepo)
  const setPersonalSkillsUrl = useGitReposStore((s) => s.setPersonalSkillsUrl)
  const setPersonalDocumentsUrl = useGitReposStore((s) => s.setPersonalDocumentsUrl)

  const [personalSkillsInput, setPersonalSkillsInput] = React.useState('')
  const [personalDocsInput, setPersonalDocsInput] = React.useState('')

  React.useEffect(() => {
    initialize()
  }, [initialize])

  React.useEffect(() => {
    setPersonalSkillsInput(config.personalSkillsUrl || '')
    setPersonalDocsInput(config.personalDocumentsUrl || '')
  }, [config])

  if (!initialized) {
    return (
      <SettingCard>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Checking git availability...</span>
        </div>
      </SettingCard>
    )
  }

  if (!gitAvailable) {
    return (
      <SettingCard>
        <div className="space-y-3">
          <h4 className="font-medium flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-yellow-500" />
            Git Not Available
          </h4>
          <p className="text-sm text-muted-foreground">
            Git CLI is not installed or not in PATH. Install git to enable repository management:
          </p>
          <div className="bg-muted rounded-md p-3 font-mono text-xs">
            brew install git
          </div>
        </div>
      </SettingCard>
    )
  }

  const handleSavePersonalSkills = async () => {
    await setPersonalSkillsUrl(personalSkillsInput)
  }
  const handleSavePersonalDocs = async () => {
    await setPersonalDocumentsUrl(personalDocsInput)
  }

  const getSyncStatusIcon = (status: string) => {
    switch (status) {
      case 'syncing':
        return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
      case 'synced':
        return <span className="h-3 w-3 rounded-full bg-green-500 inline-block" />
      case 'error':
        return <AlertCircle className="h-3 w-3 text-red-500" />
      default:
        return <span className="h-3 w-3 rounded-full bg-gray-300 dark:bg-gray-600 inline-block" />
    }
  }

  return (
    <>
      {/* Git Version Info */}
      <SettingCard>
        <div className="space-y-3">
          <h4 className="font-medium flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            {t('settings.git.title', 'Git Repositories')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {gitVersion || t('settings.git.available', 'Git available')} — {t('settings.git.description', 'Configure personal and team git repositories for skills and documents')}
          </p>
        </div>
      </SettingCard>

      {/* Personal Skills Repo */}
      <SettingCard>
        <div className="space-y-3">
          <label className="text-sm font-medium">{t('settings.git.personalSkills', 'Personal Skills Repository')}</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={t('settings.git.personalSkillsPlaceholder', 'https://github.com/user/my-skills.git')}
              value={personalSkillsInput}
              onChange={(e) => setPersonalSkillsInput(e.target.value)}
              className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSavePersonalSkills}
              disabled={personalSkillsInput === (config.personalSkillsUrl || '')}
            >
              <Save className="h-3 w-3 mr-1" />
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </SettingCard>

      {/* Personal Documents Repo */}
      <SettingCard>
        <div className="space-y-3">
          <label className="text-sm font-medium">{t('settings.git.personalDocs', 'Personal Documents Repository')}</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={t('settings.git.personalDocsPlaceholder', 'https://github.com/user/my-documents.git')}
              value={personalDocsInput}
              onChange={(e) => setPersonalDocsInput(e.target.value)}
              className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSavePersonalDocs}
              disabled={personalDocsInput === (config.personalDocumentsUrl || '')}
            >
              <Save className="h-3 w-3 mr-1" />
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </SettingCard>

      {/* Repo List & Sync */}
      {repos.length > 0 && (
        <SettingCard>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">{t('settings.git.managedRepos', 'Managed Repositories')}</h4>
              <Button
                size="sm"
                variant="outline"
                onClick={() => syncAll()}
                disabled={syncing}
                className="gap-1"
              >
                <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
                {t('settings.git.syncAll', 'Sync All')}
              </Button>
            </div>
            <div className="space-y-2">
              {repos.map((repo) => (
                <div key={repo.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {getSyncStatusIcon(repo.syncStatus)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{repo.id}</span>
                        <span className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          repo.source === 'personal'
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                            : "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300"
                        )}>
                          {repo.resourceType}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">{repo.url}</p>
                      {repo.lastError && (
                        <p className="text-[11px] text-red-500 truncate">{repo.lastError}</p>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => syncRepo(repo.id)}
                    disabled={repo.syncStatus === 'syncing'}
                    className="h-7 w-7 p-0 shrink-0"
                  >
                    <RefreshCw className={cn("h-3 w-3", repo.syncStatus === 'syncing' && "animate-spin")} />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </SettingCard>
      )}
    </>
  )
})
