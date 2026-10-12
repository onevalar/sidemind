import { useRef, type ComponentProps, type ReactNode, type Ref } from 'react'
import { Button as ArcButton, type ButtonProps } from './components/arc/button/button'
import { Input as ArcInput } from './components/arc/input/input'
import { Tooltip } from './components/arc/tooltip/tooltip'
import { Dialog as ArcDialog, DialogContent } from './components/arc/dialog/dialog'
import { FileText, Search, Plus, Minus, Maximize, LayoutGrid, Folder, Sparkles, PanelLeft, Settings, X, ArrowUp, ChevronRight, Check, Undo2, Clock, Ellipsis, Frame, Sun, RefreshCw, MessageSquare } from 'lucide-react'

export { Textarea as TextArea } from './components/arc/textarea/textarea'
export { Select } from './components/arc/select/select'
export { default as SegmentedControl } from './components/arc/segmented-control/segmented-control'
export { ContextMenu } from './components/arc/context-menu/context-menu'
export { Accordion } from './components/arc/accordion/accordion'
export { Card } from './components/arc/card/card'
export { EmptyState } from './components/arc/empty-state/empty-state'

// Keep app actions non-submitting by default, including buttons inside forms.
export function Button({ onPress, isDisabled, isIconOnly, variant = 'primary', type = 'button', className, ...props }: Omit<ButtonProps, 'variant'> & {
  ref?: Ref<HTMLButtonElement>; onPress?: () => void; isDisabled?: boolean; isIconOnly?: boolean; variant?: ButtonProps['variant'] | 'outline' | 'tertiary'
}) {
  return <ArcButton {...props} type={type} onClick={onPress ?? props.onClick} disabled={isDisabled ?? props.disabled}
    variant={variant === 'outline' ? 'secondary' : variant === 'tertiary' ? 'ghost' : variant}
    className={[isIconOnly ? 'icon-button' : '', className].filter(Boolean).join(' ')} />
}
export function Input({ fullWidth: _fullWidth, ...props }: ComponentProps<typeof ArcInput> & { fullWidth?: boolean }) {
  return <ArcInput {...props}/>
}

const icons = { note: FileText, search: Search, plus: Plus, minus: Minus, fit: Maximize, grid: LayoutGrid, folder: Folder, spark: Sparkles, panel: PanelLeft, settings: Settings, close: X, send: ArrowUp, arrow: ChevronRight, check: Check, undo: Undo2, clock: Clock, more: Ellipsis, group: Frame, sun: Sun, sync: RefreshCw, chat: MessageSquare }
export type IconName = keyof typeof icons
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = icons[name]
  return <Glyph aria-hidden="true" size={size} strokeWidth={1.75}/>
}
export function IconButton({ icon, label, onPress, isDisabled }: { icon: IconName; label: string; onPress: () => void; isDisabled?: boolean }) {
  return <Tooltip content={label}><Button type="button" variant="ghost" size="sm" isIconOnly aria-label={label} onPress={onPress} isDisabled={isDisabled}><Icon name={icon}/></Button></Tooltip>
}
export function Dialog({ title, open, onClose, children, footer, className, bare, onOpenAutoFocus }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string; bare?: boolean; onOpenAutoFocus?: (event: Event) => void }) {
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  // Capture the opener before a child input can autofocus, including nested search.
  if (open && !wasOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  wasOpen.current = open
  return <ArcDialog open={open} onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent title={title} bare={bare} aria-describedby={undefined} className={['app-dialog', className].filter(Boolean).join(' ')}
      onOpenAutoFocus={onOpenAutoFocus}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) }}
      onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}>
      {children}{footer && <div className="dialog-footer">{footer}</div>}
    </DialogContent>
  </ArcDialog>
}
