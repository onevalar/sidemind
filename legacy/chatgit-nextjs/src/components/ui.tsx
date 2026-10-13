'use client';
import type { ReactNode } from 'react';
export { Button } from '@onevalar/pro/react/button';
export { Input } from '@onevalar/pro/react/input';
export { TextArea } from '@onevalar/pro/react/textarea';
import { Modal } from '@onevalar/pro/react/modal';

export function Dialog({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode;
}) {
  return <Modal.Backdrop isOpen={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Modal.Container placement="center" size="lg"><Modal.Dialog className="app-dialog">
      <Modal.Header><Modal.Heading>{title}</Modal.Heading><Modal.CloseTrigger aria-label="关闭" /></Modal.Header>
      <Modal.Body>{children}</Modal.Body>{footer && <Modal.Footer>{footer}</Modal.Footer>}
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
export function Icon({ name, size = 18 }: { name: 'plus'|'search'|'branch'|'chat'|'grid'|'settings'|'arrow'|'back'|'copy'|'stop'|'sun'|'trash'|'folder'; size?: number }) {
  const paths = {
    plus: 'M12 5v14M5 12h14', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    branch: 'M7 6v12M7 12h6a4 4 0 0 0 4-4V6M4 3h6v6H4zM14 3h6v6h-6zM4 15h6v6H4z',
    chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
    arrow: 'M12 19V5m-6 6 6-6 6 6', back: 'M19 12H5m6-6-6 6 6 6',
    copy: 'M9 9h12v12H9zM15 9V3H3v12h6', stop: 'M6 6h12v12H6z',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
