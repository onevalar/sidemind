import type { ReactNode } from 'react'
import { Button } from '@onevalar/pro/react/button'
import { Tooltip } from '@onevalar/pro/react/tooltip'
import { Modal } from '@onevalar/pro/react/modal'

export { Button }
export { Input } from '@onevalar/pro/react/input'
export { TextArea } from '@onevalar/pro/react/textarea'

const paths = {
  note: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
  folder: <path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3h9v2"/>,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  arrow: <path d="m8 5 7 7-7 7"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  undo: <><path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5m-5 5 5 5"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  group: <><path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/><rect x="7" y="7" width="10" height="10" rx="2"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}
export function IconButton({ icon, label, onPress, isDisabled }: { icon: IconName; label: string; onPress: () => void; isDisabled?: boolean }) {
  return <Tooltip><Button variant="ghost" size="sm" isIconOnly aria-label={label} onPress={onPress} isDisabled={isDisabled}><Icon name={icon}/></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>
}
export function Dialog({ title, open, onClose, children, footer }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <Modal.Backdrop isOpen={open} onOpenChange={(v) => { if (!v) onClose() }}><Modal.Container placement="center" size="lg"><Modal.Dialog><Modal.Header><Modal.Heading>{title}</Modal.Heading><Modal.CloseTrigger /></Modal.Header><Modal.Body>{children}</Modal.Body>{footer && <Modal.Footer>{footer}</Modal.Footer>}</Modal.Dialog></Modal.Container></Modal.Backdrop>
}
