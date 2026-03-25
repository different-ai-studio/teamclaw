import * as React from 'react'
import { BarChart3, Shield, Eye, EyeOff } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { useTelemetryStore } from '@/stores/telemetry'
import { buildConfig } from '@/lib/build-config'

interface TelemetryConsentDialogProps {
  open: boolean
  onComplete: () => void
}

export function TelemetryConsentDialog({
  open,
  onComplete,
}: TelemetryConsentDialogProps) {
  const setConsent = useTelemetryStore((s) => s.setConsent)

  const handleGrant = React.useCallback(async () => {
    await setConsent('granted')
    onComplete()
  }, [setConsent, onComplete])

  const handleDeny = React.useCallback(async () => {
    await setConsent('denied')
    onComplete()
  }, [setConsent, onComplete])

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <BarChart3 className="h-6 w-6 text-primary" />
          </div>
          <AlertDialogTitle className="text-center">
            {`帮助改善 ${buildConfig.app.name}`}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-center">
            {`允许 ${buildConfig.app.name} 收集匿名使用数据，帮助我们改善 Agent 质量。`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-start gap-3 text-sm">
            <Eye className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">收集内容</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                会话时长、Token 消耗、工具调用统计、反馈评分、模型信息
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm">
            <EyeOff className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">绝不收集</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                对话内容、代码、文件路径、项目名称、个人信息
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm">
            <Shield className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">随时可改</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                可在 Settings &gt; System &gt; Privacy &amp; Telemetry 中随时关闭
              </p>
            </div>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDeny}>
            暂不开启
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleGrant}>
            允许分析
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
