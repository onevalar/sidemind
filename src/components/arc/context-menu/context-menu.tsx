"use client";

import { createPortal } from "react-dom";
import { cloneElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, HTMLAttributes, KeyboardEvent, ReactElement, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, MoreHorizontal } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./context-menu.module.css";
import { composing } from '../../../ime'

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  checked?: boolean;
}

export interface ContextMenuProps {
  /** One focusable target; clicks keep the target's own selection/navigation action. */
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  items: ContextMenuItem[];
  label?: string;
  heading?: string;
}

type Highlight = { index: number; top: number; height: number; danger: boolean; glide: boolean };

const MENU_WIDTH = 208;

// Keeps the menu 8px inside the viewport. Rows are 34px with 5px padding and a 1px border; the real size is measured before paint.
function clampTo(x: number, y: number, width: number, height: number) {
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  // The menu grows from the pointer, even when it is clamped away from a viewport edge.
  return { x: left, y: top, originX: Math.max(0, Math.min(width, x - left)), originY: Math.max(0, Math.min(height, y - top)) };
}

export function ContextMenu({ children, items, label = "对象操作", heading }: ContextMenuProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  // The portal mounts on first open (client only) and stays so the menu can animate out.
  const [portal, setPortal] = useState(false);
  // Each open gets its own key, so reopening at a new point fades the old menu out in place
  // and grows a fresh one from the pointer instead of teleporting the visible menu.
  const [point, setPoint] = useState({ x: 0, y: 0, originX: 0, originY: 0, key: 0 });
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const clearTimer = useRef(0);
  // An exiting menu keeps its last props, so its handlers check this before moving focus or selecting.
  const live = useRef(false);

  const anchor = useRef({ x: 0, y: 0 });

  useEffect(() => { live.current = open; }, [open]);
  // Re-clamp against the menu's real size before the first frame, so long labels or many rows never overflow the viewport.
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!open || !node) return;
    const next = clampTo(anchor.current.x, anchor.current.y, node.offsetWidth, node.offsetHeight);
    setPoint(current => (current.x === next.x && current.y === next.y && current.originX === next.originX && current.originY === next.originY ? current : { ...next, key: current.key }));
  }, [open, point.key]);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnViewportChange = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [open, point.key]);

  function showMenu(x: number, y: number) {
    anchor.current = { x, y };
    const estimate = clampTo(x, y, MENU_WIDTH, Math.min(300, items.length * 34 + 12));
    setPoint(current => ({ ...estimate, key: current.key + 1 }));
    window.clearTimeout(clearTimer.current);
    pointer.current = false;
    setHighlight(null);
    setPortal(true);
    setOpen(true);
  }

  function onTargetKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || composing(event)) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      const rect = targetRef.current?.getBoundingClientRect();
      if (rect) showMenu(rect.left + 12, rect.bottom + 8);
    }
  }

  function closeMenu() {
    live.current = false;
    setOpen(false);
    // Return to the real button/card, not an extra tab stop around it.
    (targetRef.current?.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    const current = document.activeElement?.getAttribute("data-index");
    const currentPosition = enabled.findIndex(({ index }) => String(index) === current);
    let nextPosition: number | undefined;
    if (event.key === "ArrowDown") nextPosition = (currentPosition + 1) % enabled.length;
    if (event.key === "ArrowUp") nextPosition = currentPosition < 0 ? enabled.length - 1 : (currentPosition - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") nextPosition = 0;
    if (event.key === "End") nextPosition = enabled.length - 1;
    if (nextPosition !== undefined && enabled.length) {
      event.preventDefault();
      event.currentTarget.querySelector<HTMLElement>(`[data-index="${enabled[nextPosition]!.index}"]`)?.focus();
    }
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); closeMenu(); }
  }

  function place(item: HTMLElement, glide: boolean) {
    window.clearTimeout(clearTimer.current);
    const next = { index: Number(item.dataset.index), top: item.offsetTop, height: item.offsetHeight, danger: item.dataset.tone === "danger" };
    setHighlight(current => ({ ...next, glide: glide && current !== null }));
  }

  // Keyboard focus places the highlight instantly; the pointer makes it glide between rows.
  function onMenuFocus(event: FocusEvent<HTMLDivElement>) {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="menuitem"]') : null;
    if (item) {
      // A pointer-opened menu focuses its first row without showing a highlight, like a native menu.
      if (!pointer.current && item.matches(":focus-visible")) place(item, false);
      return;
    }
    // A short grace period keeps the highlight gliding across the gap between rows.
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => setHighlight(null), pointer.current ? 70 : 0);
  }

  return <>
    <div ref={targetRef} className={styles.target} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showMenu(event.clientX, event.clientY); }} onKeyDown={onTargetKeyDown}>
      {cloneElement(children, { "aria-haspopup": "menu", "aria-expanded": open })}
    </div>
    {portal ? createPortal(<div aria-hidden={!open || undefined} inert={!open}><AnimatePresence>
      {open && <motion.div key={point.key} ref={node => { if (node) menuRef.current = node; }} className={styles.menu} role="menu" aria-label={label} tabIndex={-1} style={{ left: point.x, top: point.y, transformOrigin: `${point.originX}px ${point.originY}px` }} onKeyDown={onMenuKeyDown} onFocus={onMenuFocus} onPointerMoveCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }} onPointerLeave={event => { if (live.current) event.currentTarget.focus({ preventScroll: true }); }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, scale: .98, transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }} transition={reduced ? { duration: motionTokens.duration.instant } : { default: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] } }}>
        {heading && <div className={styles.heading}>{heading}</div>}
        <motion.span className={styles.highlight} data-tone={highlight?.danger ? "danger" : undefined} aria-hidden="true" initial={false} animate={highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }} transition={{ default: highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 }, opacity: { duration: reduced ? 0 : motionTokens.duration.instant } }}/>
        {items.map((item, index) => <button key={item.id} type="button" role="menuitem" tabIndex={-1} data-index={index} data-tone={item.destructive ? "danger" : undefined} style={{ "--i": index } as CSSProperties} disabled={item.disabled} className={[styles.item, item.destructive ? styles.destructive : ""].filter(Boolean).join(" ")} onPointerMove={event => { if (!live.current) return; window.clearTimeout(clearTimer.current); if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); if (highlight?.index !== index) place(event.currentTarget, true); }} onPointerLeave={() => { if (live.current) menuRef.current?.focus({ preventScroll: true }); }} onClick={() => { if (!live.current) return; closeMenu(); item.onSelect?.(); }}>
          <span className={styles.icon} aria-hidden="true">{item.icon ?? (item.checked ? <Check size={15} /> : <MoreHorizontal size={15} />)}</span><span>{item.label}</span>
        </button>)}
      </motion.div>}
    </AnimatePresence></div>, document.body) : null}
  </>;
}

export default ContextMenu;
