import * as React from "react"
import type { ComponentRegistry, ComponentRenderProps } from "@json-render/react"
import { useDataBinding } from "@json-render/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

// Card 组件渲染器
function CardRenderer({ element, children }: ComponentRenderProps<{
  title?: string
  description?: string
}>) {
  const { props } = element
  
  return (
    <Card className="w-full">
      {(props.title || props.description) && (
        <CardHeader>
          {props.title && <CardTitle>{props.title}</CardTitle>}
          {props.description && <CardDescription>{props.description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// Form 组件渲染器
function FormRenderer({ element, children }: ComponentRenderProps<{
  id: string
}>) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Form submission is handled by action system
  }
  
  return (
    <form id={element.props.id} onSubmit={handleSubmit} className="space-y-4">
      {children}
    </form>
  )
}

// FormField 组件渲染器
function FormFieldRenderer({ element, children }: ComponentRenderProps<{
  label: string
  name: string
  required?: boolean
}>) {
  const { props } = element
  
  return (
    <div className="space-y-2">
      {props.label && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {props.label}
          {props.required && <span className="text-destructive ml-1">*</span>}
        </label>
      )}
      {children}
    </div>
  )
}

// Input 组件渲染器
function InputRenderer({ element }: ComponentRenderProps<{
  placeholder?: string
  type?: "text" | "email" | "password" | "number" | "tel" | "url"
  valuePath?: string
  disabled?: boolean
}>) {
  const { props } = element
  const [value, setValue] = useDataBinding<string>(props.valuePath || "")
  
  return (
    <Input
      type={props.type || "text"}
      placeholder={props.placeholder}
      disabled={props.disabled}
      value={value || ""}
      onChange={(e) => setValue(e.target.value)}
    />
  )
}

// Textarea 组件渲染器
function TextareaRenderer({ element }: ComponentRenderProps<{
  placeholder?: string
  valuePath?: string
  rows?: number
  disabled?: boolean
}>) {
  const { props } = element
  const [value, setValue] = useDataBinding<string>(props.valuePath || "")
  
  return (
    <Textarea
      placeholder={props.placeholder}
      disabled={props.disabled}
      rows={props.rows}
      value={value || ""}
      onChange={(e) => setValue(e.target.value)}
    />
  )
}

// Select 组件渲染器
function SelectRenderer({ element }: ComponentRenderProps<{
  placeholder?: string
  valuePath?: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
}>) {
  const { props } = element
  const [value, setValue] = useDataBinding<string>(props.valuePath || "")
  
  // 过滤掉无效的选项（流式解析时可能有不完整的数据）
  const validOptions = (props.options || []).filter(
    (option) => option && typeof option.value === 'string' && option.value !== '' && option.label
  )
  
  return (
    <Select value={value || ""} onValueChange={setValue} disabled={props.disabled}>
      <SelectTrigger>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        {validOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Button 组件渲染器
function ButtonRenderer({ element }: ComponentRenderProps<{
  label: string
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
  size?: "default" | "sm" | "lg" | "icon"
  disabled?: boolean
}>) {
  const { props } = element
  
  // 流式解析时 label 可能为空
  if (!props.label) {
    return null
  }
  
  return (
    <Button
      variant={props.variant}
      size={props.size}
      disabled={props.disabled}
    >
      {props.label}
    </Button>
  )
}

// Text 组件渲染器
function TextRenderer({ element }: ComponentRenderProps<{
  content: string
  variant?: "default" | "muted" | "heading" | "label"
}>) {
  const { props } = element
  
  // 流式解析时 content 可能为空
  if (!props.content) {
    return null
  }
  
  const className = cn(
    props.variant === "muted" && "text-muted-foreground text-sm",
    props.variant === "heading" && "text-lg font-semibold",
    props.variant === "label" && "text-sm font-medium",
    !props.variant && "text-sm"
  )
  
  if (props.variant === "heading") {
    return <h3 className={className}>{props.content}</h3>
  }
  
  return <p className={className}>{props.content}</p>
}

// Badge 组件渲染器
function BadgeRenderer({ element }: ComponentRenderProps<{
  label: string
  variant?: "default" | "secondary" | "destructive" | "outline"
}>) {
  const { props } = element
  
  // 流式解析时 label 可能为空
  if (!props.label) {
    return null
  }
  
  return <Badge variant={props.variant}>{props.label}</Badge>
}

// Divider 组件渲染器
function DividerRenderer({ element }: ComponentRenderProps<{
  orientation?: "horizontal" | "vertical"
}>) {
  const { props } = element
  
  return <Separator orientation={props.orientation} />
}

// Stack 布局组件渲染器
function StackRenderer({ element, children }: ComponentRenderProps<{
  direction?: "row" | "column"
  gap?: "sm" | "md" | "lg"
  align?: "start" | "center" | "end" | "stretch"
  justify?: "start" | "center" | "end" | "between" | "around"
}>) {
  const { props } = element
  
  const gapClass = {
    sm: "gap-2",
    md: "gap-4",
    lg: "gap-6",
  }[props.gap || "md"]
  
  const alignClass = {
    start: "items-start",
    center: "items-center",
    end: "items-end",
    stretch: "items-stretch",
  }[props.align || "stretch"]
  
  const justifyClass = {
    start: "justify-start",
    center: "justify-center",
    end: "justify-end",
    between: "justify-between",
    around: "justify-around",
  }[props.justify || "start"]
  
  return (
    <div
      className={cn(
        "flex",
        props.direction === "row" ? "flex-row" : "flex-col",
        gapClass,
        alignClass,
        justifyClass
      )}
    >
      {children}
    </div>
  )
}

// Metric 组件渲染器
function MetricRenderer({ element }: ComponentRenderProps<{
  label: string
  valuePath?: string
  value?: string | number
  format?: "number" | "currency" | "percent"
}>) {
  const { props } = element
  const [boundValue] = useDataBinding<string | number>(props.valuePath || "")
  const displayValue = props.value ?? boundValue ?? "-"
  
  const formatValue = (val: string | number) => {
    if (typeof val === "number" || !isNaN(Number(val))) {
      const num = Number(val)
      switch (props.format) {
        case "currency":
          return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(num)
        case "percent":
          return new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1 }).format(num / 100)
        case "number":
        default:
          return new Intl.NumberFormat("zh-CN").format(num)
      }
    }
    return val
  }
  
  return (
    <div className="flex flex-col">
      {props.label && <span className="text-sm text-muted-foreground">{props.label}</span>}
      <span className="text-2xl font-semibold">{formatValue(displayValue)}</span>
    </div>
  )
}

// Fallback 组件
function FallbackRenderer({ element }: ComponentRenderProps) {
  return (
    <div className="rounded-md border border-dashed border-muted-foreground/50 p-4 text-sm text-muted-foreground">
      Unknown component: {element.type}
    </div>
  )
}

/**
 * 组件注册表 - 将目录中的组件映射到实际的 React 组件
 */
export const componentRegistry: ComponentRegistry = {
  Card: CardRenderer,
  Form: FormRenderer,
  FormField: FormFieldRenderer,
  Input: InputRenderer,
  Textarea: TextareaRenderer,
  Select: SelectRenderer,
  Button: ButtonRenderer,
  Text: TextRenderer,
  Badge: BadgeRenderer,
  Divider: DividerRenderer,
  Stack: StackRenderer,
  Metric: MetricRenderer,
}

export const fallbackComponent = FallbackRenderer
