import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ApplicationDialogProps {
  teamName: string
  onSubmit: (name: string, email: string, note: string) => Promise<void>
  onCancel: () => void
}

export function ApplicationDialog({ teamName, onSubmit, onCancel }: ApplicationDialogProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      await onSubmit(name, email, note)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <h3 className="text-base font-semibold">申请加入团队</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          你的设备尚未加入「{teamName}」，请填写信息后提交申请
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              姓名 <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入你的姓名"
              className="bg-background/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              邮箱 <span className="text-destructive">*</span>
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="输入你的邮箱"
              className="bg-background/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">备注</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：前端开发，负责 Dashboard 模块"
              rows={2}
              className="w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || !name || !email}
          >
            {submitting ? '提交中...' : '提交申请'}
          </Button>
        </div>
      </div>
    </div>
  )
}
