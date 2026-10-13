"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./glass-menu.module.css";

/** One row in the menu. Give it `items` to make it open a submenu. */
export interface GlassMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shortcut hint shown on the right, such as "⌘D". Display only; wire the real shortcut yourself. */
  shortcut?: string;
  /** Renders a checkable row with a check mark when true. Leave undefined for plain actions. */
  checked?: boolean;
  /** Tints the row with the danger color, for destructive actions. */
  danger?: boolean;
  disabled?: boolean;
  /** Nested rows. The submenu slides in place of the menu, one level deep. */
  items?: GlassMenuItem[];
  /** Keeps the menu open after this row is chosen. Handy for checkable rows. */
  keepOpen?: boolean;
}

/** A labelled cluster of rows. Groups are separated by a hairline. */
export interface GlassMenuGroup {
  id: string;
  /** Optional quiet heading above the group. */
  label?: string;
  items: GlassMenuItem[];
}

/**
 * A glass action menu. The trigger morphs into the panel on a spring, a glass pill slides between the rows under the
 * pointer or the keyboard, one level of submenu slides in place, and the panel morphs back into the trigger on close.
 */
export interface GlassMenuProps {
  /** Rows, in groups. */
  groups: GlassMenuGroup[];
  /** Trigger content, usually an icon and a short label. */
  children: ReactNode;
  /** Accessible name of the menu. Defaults to "Actions". */
  label?: string;
  /** Accessible name of the trigger when it only shows an icon. */
  triggerLabel?: string;
  /** Controlled open state. */
  open?: boolean;
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called with the chosen row. Rows with a submenu open it instead. */
  onSelect?: (id: string, item: GlassMenuItem) => void;
  /** Which edge of the trigger the panel grows from. Defaults to "start". */
  align?: "start" | "end";
  /** Panel width in px. Defaults to 256; it never exceeds the viewport. */
  width?: number;
  className?: string;
  style?: CSSProperties;
}

type Row = { item: GlassMenuItem; groupIndex: number; groupLabel?: string } | { back: GlassMenuItem };
const BACK = "__glass-menu-back";
const isBack = (row: Row): row is { back: GlassMenuItem } => "back" in row;
const rowId = (row: Row) => isBack(row) ? BACK : row.item.id;
const rowItem = (row: Row) => isBack(row) ? row.back : row.item;

export function GlassMenu({ groups, children, label = "Actions", triggerLabel, open: openProp, defaultOpen = false, onOpenChange, onSelect, align = "start", width = 256, className, style }: GlassMenuProps) {
  const reduced = !!useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeahead = useRef({ text: "", at: 0 });
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = openProp ?? innerOpen;
  const [view, setView] = useState<string | null>(null);
  const [direction, setDirection] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const [triggerBox, setTriggerBox] = useState({ w: 0, h: 40 });

  const setOpen = useCallback((next: boolean) => {
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }, [openProp, onOpenChange]);

  const parent = useMemo(() => {
    if (!view) return null;
    for (const group of groups) for (const item of group.items) if (item.id === view && item.items) return item;
    return null;
  }, [groups, view]);

  const rows = useMemo<Row[]>(() => {
    if (parent) return [{ back: { id: BACK, label: parent.label, icon: <ChevronLeft size={16} strokeWidth={1.75} aria-hidden /> } }, ...(parent.items ?? []).map(item => ({ item, groupIndex: 1 }))];
    return groups.flatMap((group, groupIndex) => group.items.map(item => ({ item, groupIndex, groupLabel: group.label })));
  }, [groups, parent]);
  const enabled = useMemo(() => rows.filter(row => !rowItem(row).disabled).map(rowId), [rows]);
  const viewKey = view ?? "root";
  // Reserve the icon and trailing columns across a view so labels and shortcuts line up row to row.
  const leading = rows.some(row => !!rowItem(row).icon);
  const trailing = rows.some(row => rowItem(row).checked !== undefined || !!rowItem(row).items?.length);

  // The panel is placed at the trigger, so its first frame is the trigger's box.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const measure = () => setTriggerBox(box => box.w === trigger.offsetWidth && box.h === trigger.offsetHeight ? box : { w: trigger.offsetWidth, h: trigger.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(trigger);
    return () => ro.disconnect();
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, [setOpen]);

  const openMenu = (withKeyboard: boolean, last = false) => {
    setView(null);
    setDirection(1);
    setHeight("auto");
    const ids = groups.flatMap(group => group.items).filter(item => !item.disabled).map(item => item.id);
    setActive(withKeyboard ? (last ? ids.at(-1) : ids[0]) ?? null : null);
    setOpen(true);
  };

  // Reset to the top level whenever the menu closes, including from outside.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) { setView(null); setActive(null); }
  }

  // Focus follows the highlighted row; with no row, the menu itself holds focus so the keys still work.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target = active ? itemRefs.current.get(`${viewKey}:${active}`) : menuRef.current;
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active, viewKey]);

  // Outside press closes without stealing focus from whatever was pressed.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, close]);

  const measureView = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const set = () => setHeight(node.offsetHeight);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const enter = (item: GlassMenuItem) => {
    setDirection(1);
    setView(item.id);
    setActive(item.items?.find(child => !child.disabled)?.id ?? BACK);
  };
  const back = () => {
    const from = view;
    setDirection(-1);
    setView(null);
    setActive(from);
  };

  const choose = (row: Row) => {
    const item = rowItem(row);
    if (item.disabled) return;
    if (isBack(row)) { back(); return; }
    if (item.items?.length) { enter(item); return; }
    onSelect?.(item.id, item);
    if (!item.keepOpen) close(true);
  };

  const move = (to: "next" | "prev" | "first" | "last") => {
    if (!enabled.length) return;
    const index = active ? enabled.indexOf(active) : -1;
    const next = to === "first" ? 0 : to === "last" ? enabled.length - 1
      : to === "next" ? (index < 0 ? 0 : (index + 1) % enabled.length)
      : (index < 0 ? enabled.length - 1 : (index - 1 + enabled.length) % enabled.length);
    setActive(enabled[next]);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const row = rows.find(entry => rowId(entry) === active);
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); move("next"); return;
      case "ArrowUp": event.preventDefault(); move("prev"); return;
      case "Home": case "PageUp": event.preventDefault(); move("first"); return;
      case "End": case "PageDown": event.preventDefault(); move("last"); return;
      case "Enter": case " ":
        event.preventDefault();
        if (row) choose(row);
        return;
      case "ArrowRight":
        if (row && !isBack(row) && row.item.items?.length && !row.item.disabled) { event.preventDefault(); enter(row.item); }
        return;
      case "ArrowLeft":
        if (view) { event.preventDefault(); back(); }
        return;
      case "Escape":
        event.preventDefault();
        if (view) back(); else close(true);
        return;
      case "Tab":
        event.preventDefault();
        close(true);
        return;
    }
    // Typeahead: typed letters jump to the next row whose label starts with them.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = performance.now();
      const text = (now - typeahead.current.at < 700 ? typeahead.current.text : "") + event.key.toLowerCase();
      typeahead.current = { text, at: now };
      const start = active ? enabled.indexOf(active) + (text.length === 1 ? 1 : 0) : 0;
      const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
      const hit = ordered.find(id => rowItem(rows.find(entry => rowId(entry) === id)!).label.toLowerCase().startsWith(text));
      if (hit) setActive(hit);
    }
  };

  const onTriggerKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); openMenu(true); }
    else if (event.key === "ArrowUp") { event.preventDefault(); openMenu(true, true); }
  };

  const morph: Transition = reduced ? { duration: 0 } : motionTokens.spring.morph;
  const glide: Transition = reduced ? { duration: 0 } : motionTokens.spring.morph;
  const slide: Transition = reduced ? { duration: 0 } : motionTokens.spring.smooth;
  const variants: Variants = {
    enter: (dir: number) => reduced ? { opacity: 1 } : { x: dir * 36, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => reduced ? { opacity: 0 } : { x: dir * -36, opacity: 0 },
  };
  const shellId = `${uid}-shell`;
  const menuId = `${uid}-menu`;
  const panelWidth = `min(${width}px, calc(100vw - 24px))`;
  const radius = Math.min(triggerBox.h / 2, 22);
  // The rows are clipped to the shell as it grows out of the trigger, so nothing shows outside the glass mid-morph.
  const clipFrom = align === "end"
    ? `inset(0px 0px calc(100% - ${triggerBox.h}px) calc(100% - ${triggerBox.w}px) round ${radius}px)`
    : `inset(0px calc(100% - ${triggerBox.w}px) calc(100% - ${triggerBox.h}px) 0px round ${radius}px)`;
  const clipTo = align === "end" ? "inset(0px 0px calc(0% - 0px) calc(0% - 0px) round 22px)" : "inset(0px calc(0% - 0px) calc(0% - 0px) 0px round 22px)";

  const renderRow = (row: Row, index: number) => {
    const item = rowItem(row);
    const id = rowId(row);
    const isActive = active === id;
    const previous = index > 0 ? rows[index - 1] : null;
    const newGroup = !isBack(row) && previous && !isBack(previous) && previous.groupIndex !== row.groupIndex;
    const heading = !isBack(row) && row.groupLabel && (!previous || isBack(previous) || previous.groupIndex !== row.groupIndex) ? row.groupLabel : null;
    const checkable = item.checked !== undefined;
    return <div key={id} role="none" className={styles.rowWrap}>
      {(newGroup || (isBack(previous ?? row) && index === 1)) && <div role="separator" className={styles.separator} />}
      {heading && <div role="presentation" className={styles.heading}>{heading}</div>}
      <button
        ref={node => { const key = `${viewKey}:${id}`; if (node) itemRefs.current.set(key, node); else itemRefs.current.delete(key); }}
        type="button"
        role={checkable ? "menuitemcheckbox" : "menuitem"}
        aria-checked={checkable ? !!item.checked : undefined}
        aria-haspopup={item.items?.length ? "menu" : undefined}
        aria-disabled={item.disabled || undefined}
        tabIndex={-1}
        className={styles.item}
        data-active={isActive ? "" : undefined}
        data-danger={item.danger ? "" : undefined}
        data-back={isBack(row) ? "" : undefined}
        onPointerMove={() => { if (!item.disabled && active !== id) setActive(id); }}
        onClick={() => choose(row)}
      >
        {isActive && <motion.span layoutId={`${uid}-glide-${viewKey}`} className={styles.highlight} transition={glide} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} aria-hidden />}
        {(item.icon || leading) && <span className={styles.icon} aria-hidden>{item.icon}</span>}
        <span className={styles.label}>{item.label}</span>
        {item.shortcut && <kbd className={styles.shortcut}>{item.shortcut}</kbd>}
        {checkable && <Check className={styles.check} data-on={item.checked ? "" : undefined} size={16} strokeWidth={2} aria-hidden />}
        {item.items?.length ? <ChevronRight className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden /> : !checkable && trailing ? <span className={styles.trail} aria-hidden /> : null}
      </button>
    </div>;
  };

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={style} data-open={open ? "" : undefined}>
    <button
      ref={triggerRef}
      type="button"
      className={styles.trigger}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={triggerLabel}
      onClick={() => open ? close(true) : openMenu(false)}
      onKeyDown={onTriggerKey}
    >
      {!open && <motion.span layoutId={shellId} className={styles.shell} style={{ borderRadius: radius }} transition={morph} aria-hidden />}
      <span className={styles.triggerContent}>{children}</span>
    </button>

    <AnimatePresence>
      {open && <div key="panel" className={styles.panel} data-align={align} style={{ width: panelWidth, minHeight: triggerBox.h }}>
        <motion.div layoutId={shellId} className={styles.shell} style={{ borderRadius: 22 }} transition={morph} aria-hidden />
        <motion.div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={parent ? parent.label : label}
          tabIndex={-1}
          className={styles.menu}
          onKeyDown={onMenuKey}
          onPointerLeave={() => setActive(null)}
          initial={reduced ? { opacity: 0 } : { opacity: 0, clipPath: clipFrom, filter: `blur(${motionTokens.blur.soft}px)` }}
          animate={{ opacity: 1, clipPath: reduced ? "none" : clipTo, filter: "blur(0px)", transition: reduced ? { duration: 0 } : { opacity: { duration: motionTokens.duration.fast, delay: .06 }, filter: { duration: motionTokens.duration.standard, delay: .06 }, clipPath: morph } }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, clipPath: clipFrom, filter: `blur(${motionTokens.blur.soft}px)`, transition: { opacity: { duration: motionTokens.duration.instant }, filter: { duration: motionTokens.duration.instant }, clipPath: morph } }}
        >
          <motion.div className={styles.viewport} initial={false} animate={{ height }} transition={slide}>
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
              <motion.div key={viewKey} className={styles.view} custom={direction} variants={variants} initial="enter" animate="center" exit="exit" transition={slide}>
                <div ref={measureView} className={styles.list}>
                  {rows.map(renderRow)}
                </div>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </div>}
    </AnimatePresence>
  </div>;
}

export default GlassMenu;
