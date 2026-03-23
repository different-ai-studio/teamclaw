import { useTranslation } from 'react-i18next'
import { User, Users } from 'lucide-react'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'

interface WorkspaceTypeDialogProps {
  open: boolean
  onSelectPersonal: () => void
  onSelectTeam: () => void
}

export function WorkspaceTypeDialog({ open, onSelectPersonal, onSelectTeam }: WorkspaceTypeDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 gap-0 overflow-hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="p-6 pb-2 text-center">
          <h2 className="text-lg font-medium">
            {t('workspace.typeDialog.title', '你打算怎么使用这个工作区？')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('workspace.typeDialog.subtitle', '你随时可以在设置中更改')}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 p-6">
          <button
            onClick={onSelectPersonal}
            className="flex flex-col items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-5 transition-colors hover:bg-muted/60 hover:border-border cursor-pointer"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
              <User className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium">
                {t('workspace.typeDialog.personal', '个人使用')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('workspace.typeDialog.personalDesc', '独立工作，无需同步')}
              </div>
            </div>
          </button>

          <button
            onClick={onSelectTeam}
            className="flex flex-col items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-5 transition-colors hover:bg-muted/60 hover:border-border cursor-pointer"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium">
                {t('workspace.typeDialog.team', '团队协作')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('workspace.typeDialog.teamDesc', '加入团队，同步共享资源')}
              </div>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
