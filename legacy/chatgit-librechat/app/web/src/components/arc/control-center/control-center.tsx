"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { Bell, BellOff, ChevronRight, MonitorUp, Presentation, Type, Volume1, Volume2, VolumeX, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./control-center.module.css";

export interface ControlCenterFocusMode {
  id: string;
  label: string;
  icon: LucideIcon;
  /** One line about what the mode silences. */
  description: string;
  /** Minutes the dial starts at when this mode is picked. */
  defaultMinutes: number;
}
export interface ControlCenterChannel { id: string; label: string; description?: string; defaultOn?: boolean }
export interface ControlCenterPerson { id: string; name: string; avatar: string }
export interface ControlCenterFocus { mode: string; minutes: number; /** Formatted end time, such as "3:25 PM". */ until: string }
export interface ControlCenterState {
  focus: ControlCenterFocus | null;
  notifications: boolean;
  channels: Record<string, boolean>;
  presenting: boolean;
  /** Between 0 and 100. */
  volume: number;
  /** Percent of the base text size, between 85 and 130. */
  textSize: number;
}

/** Quick settings for a web workspace: focus sessions, notification channels, presenting mode, alert volume, and text size.
 *  Tiles act on a tap. The chevron grows a tile into its detail with a shared element morph, and meters track the pointer 1:1 with rubber-banded edges. */
export interface ControlCenterProps {
  focusModes: ControlCenterFocusMode[];
  channels: ControlCenterChannel[];
  /** People who can still reach you while a focus session runs. */
  people?: ControlCenterPerson[];
  defaultVolume?: number;
  defaultTextSize?: number;
  /** Formats the end of a session. Defaults to a short en-US clock time. */
  formatTime?: (date: Date) => string;
  onStateChange?: (state: ControlCenterState) => void;
  label?: string;
  className?: string;
}

type PanelId = "focus" | "notifications";

const TEXT_MIN = 85;
const TEXT_MAX = 130;
const DIAL_MAX = 120;
const DIAL_STEP = 5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** The further past the edge, the less the element follows. */
function rubberband(overshoot: number, dimension: number, constant = .55) {
  const sign = Math.sign(overshoot);
  const distance = Math.abs(overshoot);
  return sign * (distance * dimension * constant) / (dimension + constant * distance);
}
const defaultFormat = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/* Icon swap: the old glyph shrinks under a light blur while the new one arrives, so the change reads as one object. */
function SwapIcon({ icon: Icon, swapKey, size = 20 }: { icon: LucideIcon; swapKey: string; size?: number }) {
  return <span className={styles.swap} style={{ width: size, height: size }} aria-hidden="true">
    <AnimatePresence initial={false}>
      <motion.span key={swapKey} className={styles.swapPhase}
        initial={{ opacity: 0, scale: .7, filter: `blur(${motionTokens.blur.subtle}px)` }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: .7, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant } }}
        transition={{ scale: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.fast } }}>
        <Icon size={size} strokeWidth={1.75} />
      </motion.span>
    </AnimatePresence>
  </span>;
}

/* Status copy rolls vertically when it changes, keeping the tile's height. */
function RollText({ text }: { text: string }) {
  return <span className={styles.roll}>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={text} className={styles.rollPhase}
        initial={{ opacity: 0, y: "0.6em", filter: `blur(${motionTokens.blur.subtle}px)` }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: "-0.6em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant } }}
        transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

interface TileProps {
  id: string;
  icon: LucideIcon;
  iconKey: string;
  title: string;
  status: string;
  active: boolean;
  wide?: boolean;
  open: boolean;
  onPress: () => void;
  onExpand?: () => void;
  expandLabel?: string;
  registerExpand?: (node: HTMLButtonElement | null) => void;
}

function Tile({ id, icon, iconKey, title, status, active, wide, open, onPress, onExpand, expandLabel, registerExpand }: TileProps) {
  return <div className={styles.slot} data-wide={wide || undefined}>
    {!open && <motion.div layoutId={`cc-${id}`} className={styles.tile} data-active={active || undefined} style={{ borderRadius: 22 }} whileTap={{ scale: .975 }} transition={motionTokens.spring.morph}>
      <button type="button" className={styles.tileMain} aria-pressed={active} onClick={onPress}>
        <motion.span layoutId={`cc-${id}-icon`} layout="position" className={styles.tileIcon}><SwapIcon icon={icon} swapKey={iconKey} /></motion.span>
        <span className={styles.tileText}>
          <motion.span layoutId={`cc-${id}-title`} layout="position" className={styles.tileTitle}>{title}</motion.span>
          <motion.span layout="position" className={styles.tileStatus}><RollText text={status} /></motion.span>
        </span>
      </button>
      {/* The chevron and the detail's close button share a layoutId, so the control travels with its corner instead of appearing out of place. */}
      {onExpand && <motion.button layoutId={`cc-${id}-action`} layout="position" ref={registerExpand} type="button" className={styles.tileExpand} aria-label={expandLabel} aria-haspopup="dialog" onClick={onExpand}>
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
      </motion.button>}
    </motion.div>}
  </div>;
}

/** Thumb travel: 40px track - 6px padding - 18px thumb. Keep in sync with control-center.module.css. */
const switchTravel = 16;
const switchGlide = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;

/* Same feel as the registry switch: a critically damped glide, a brief stretch in flight, a wider thumb while pressed, and a track crossfade. */
function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (next: boolean) => void; label: string; description?: string }) {
  const id = useId();
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const scaleX = useMotionValue(1);
  const shown = useRef(checked);
  useEffect(() => {
    if (shown.current === checked) return;
    shown.current = checked;
    if (reduced) return;
    const controls = animate(scaleX, [1, 1.16, 1], { duration: 0.34, times: [0, 0.4, 1], ease: ["easeOut", "easeInOut"] });
    return () => controls.stop();
  }, [checked, reduced, scaleX]);
  const extra = pressed && !reduced ? 5 : 0;
  return <div className={styles.row}>
    <span className={styles.rowText}>
      <span id={`${id}-label`} className={styles.rowLabel}>{label}</span>
      {description && <span className={styles.rowDescription}>{description}</span>}
    </span>
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-label`} className={styles.switch} data-on={checked || undefined} onClick={() => onChange(!checked)}
      onPointerDown={event => { if (event.button === 0) setPressed(true); }} onPointerUp={() => setPressed(false)} onPointerLeave={() => setPressed(false)} onPointerCancel={() => setPressed(false)}
      onKeyDown={event => { if (event.key === " ") setPressed(true); }} onKeyUp={() => setPressed(false)} onBlur={() => setPressed(false)}>
      <motion.span className={styles.switchThumb} style={{ scaleX }} initial={false} animate={{ x: checked ? switchTravel - extra : 0, width: 18 + extra }} transition={reduced ? { duration: 0 } : { x: switchGlide, width: motionTokens.spring.snappy }} />
    </button>
  </div>;
}

interface MeterProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  segments: number;
  format: (value: number) => string;
  icon: ReactNode;
  trailing?: (progress: MotionValue<number>) => ReactNode;
  onChange: (value: number) => void;
}

/* A segmented meter. Dragging moves the fill 1:1 from wherever it was grabbed; past either end the track stretches with rubber-band resistance and springs back on release. */
function Meter({ label, value, min, max, step, segments, format, icon, trailing, onChange }: MeterProps) {
  const id = useId();
  const range = max - min;
  const progress = useMotionValue((value - min) / range);
  const stretch = useMotionValue(0);
  const drag = useRef<{ pointer: number; x: number; start: number; width: number; left: number; room: number; moved: boolean } | null>(null);
  const clip = useTransform(progress, p => `inset(0 ${(1 - clamp(p, 0, 1)) * 100}% 0 0)`);
  const readout = useTransform(progress, p => format(Math.round((min + clamp(p, 0, 1) * range) / step) * step));
  const width = useMotionValue(240);
  const scaleX = useTransform(() => 1 + Math.abs(stretch.get()) / Math.max(1, width.get()));
  const x = useTransform(stretch, s => s / 2);
  // The track swells a little while held, so the press registers before any travel.
  const grow = useMotionValue(1);
  // Reduced motion: values jump to where they land, with no swell or rubber band.
  const reduced = useReducedMotion() ?? false;
  const settle = (next: number) => reduced ? progress.set((next - min) / range) : animate(progress, (next - min) / range, motionTokens.spring.snappy);

  useMotionValueEvent(progress, "change", p => {
    const next = Math.round((min + clamp(p, 0, 1) * range) / step) * step;
    if (drag.current && next !== value) onChange(next);
  });

  function commit(next: number) {
    const snapped = clamp(Math.round(next / step) * step, min, max);
    onChange(snapped);
    settle(snapped);
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // The stretch stays inside the panel's padding, in line with the tiles: its limit is the room between the track and the panel's content edge.
    const panel = event.currentTarget.closest("section");
    const box = panel?.getBoundingClientRect();
    const css = panel ? getComputedStyle(panel) : null;
    const inset = css ? (parseFloat(css.borderLeftWidth) || 0) + (parseFloat(css.paddingLeft) || 0) : 0;
    const room = box ? Math.max(0, Math.min(rect.left - box.left, box.right - rect.right) - inset) : 6;
    event.currentTarget.setPointerCapture(event.pointerId);
    progress.stop();
    width.set(rect.width);
    if (!reduced) animate(grow, 1.18, motionTokens.spring.snappy);
    drag.current = { pointer: event.pointerId, x: event.clientX, start: progress.get(), width: rect.width, left: rect.left, room, moved: false };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 3) return;
    state.moved = true;
    const raw = state.start + dx / state.width;
    progress.set(clamp(raw, 0, 1));
    if (!reduced) stretch.set(raw < 0 ? rubberband(raw * state.width, state.room) : raw > 1 ? rubberband((raw - 1) * state.width, state.room) : 0);
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    animate(grow, 1, motionTokens.spring.snappy);
    // A press the browser takes back (a vertical scroll on touch, or lost capture) is not a tap: the value stays.
    if (event.type !== "pointerup" && !state.moved) return;
    animate(stretch, 0, { type: "spring", visualDuration: .4, bounce: .15 });
    // A tap jumps to that spot; a drag keeps where the fill was left.
    const p = state.moved ? progress.get() : clamp((event.clientX - state.left) / state.width, 0, 1);
    commit(min + p * range);
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const map: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 4, PageDown: -step * 4, Home: -Infinity, End: Infinity };
    if (!(event.key in map)) return;
    event.preventDefault();
    const delta = map[event.key];
    commit(delta === Infinity ? max : delta === -Infinity ? min : clamp(value + delta, min, max));
  }

  return <div className={styles.meter}>
    <div className={styles.meterHead}>
      <span className={styles.meterIcon} aria-hidden="true">{icon}</span>
      <span id={`${id}-label`} className={styles.meterLabel}>{label}</span>
      {/* The value closes every row, so the readouts line up on the right edge whether or not a row has a preview. */}
      {trailing?.(progress)}
      <motion.span className={styles.meterValue} aria-hidden="true">{readout}</motion.span>
    </div>
    <motion.div className={styles.meterTrack} role="slider" tabIndex={0} aria-labelledby={`${id}-label`}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={format(value)}
      style={{ scaleX, scaleY: grow, x }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd} onKeyDown={onKeyDown}>
      <span className={styles.meterSegments} aria-hidden="true">{Array.from({ length: segments }, (_, i) => <span key={i} />)}</span>
      <motion.span className={styles.meterSegments} data-fill aria-hidden="true" style={{ clipPath: clip }}>{Array.from({ length: segments }, (_, i) => <span key={i} />)}</motion.span>
    </motion.div>
  </div>;
}

/* A precise duration dial: drag around the ring or use arrow keys. Minutes count as the knob travels; past the ends the knob resists and springs home. */
function FocusDial({ minutes, onChange, until }: { minutes: number; onChange: (value: number) => void; until: (value: number) => string }) {
  const value = useMotionValue(minutes);
  const overshoot = useMotionValue(0);
  const reduced = useReducedMotion() ?? false;
  const drag = useRef<{ pointer: number; angle: number; raw: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const turn = useTransform(() => ((value.get() + overshoot.get()) / DIAL_MAX) * 360);
  const arc = useTransform(value, v => v / DIAL_MAX);
  const count = useTransform(value, v => String(Math.round(v)));
  const end = useTransform(value, v => `Until ${until(Math.round(v / DIAL_STEP) * DIAL_STEP)}`);

  // Picking another mode, or a key press, glides the dial to the new length from wherever it is.
  useEffect(() => {
    if (drag.current) return;
    const controls = animate(value, minutes, reduced ? { duration: 0 } : motionTokens.spring.snappy);
    return () => controls.stop();
  }, [minutes, value, reduced]);

  useMotionValueEvent(value, "change", v => {
    const snapped = clamp(Math.round(v / DIAL_STEP) * DIAL_STEP, DIAL_STEP, DIAL_MAX);
    if (drag.current && snapped !== minutes) onChange(snapped);
  });

  function angleOf(event: { clientX: number; clientY: number }) {
    const rect = ref.current!.getBoundingClientRect();
    const deg = Math.atan2(event.clientX - (rect.left + rect.width / 2), -(event.clientY - (rect.top + rect.height / 2))) * 180 / Math.PI;
    return (deg + 360) % 360;
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    value.stop();
    drag.current = { pointer: event.pointerId, angle: angleOf(event), raw: value.get() };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const angle = angleOf(event);
    // Unwrap the angle so crossing twelve o'clock keeps counting instead of jumping.
    let delta = angle - state.angle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    state.angle = angle;
    state.raw += (delta / 360) * DIAL_MAX;
    const clamped = clamp(state.raw, DIAL_STEP, DIAL_MAX);
    value.set(clamped);
    if (!reduced) overshoot.set(rubberband(state.raw - clamped, 30, .4));
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    const snapped = clamp(Math.round(value.get() / DIAL_STEP) * DIAL_STEP, DIAL_STEP, DIAL_MAX);
    animate(overshoot, 0, { type: "spring", visualDuration: .4, bounce: .15 });
    animate(value, snapped, reduced ? { duration: 0 } : motionTokens.spring.snappy);
    onChange(snapped);
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const map: Record<string, number> = { ArrowRight: DIAL_STEP, ArrowUp: DIAL_STEP, ArrowLeft: -DIAL_STEP, ArrowDown: -DIAL_STEP, PageUp: 15, PageDown: -15, Home: -DIAL_MAX, End: DIAL_MAX };
    if (!(event.key in map)) return;
    event.preventDefault();
    onChange(clamp(minutes + map[event.key], DIAL_STEP, DIAL_MAX));
  }

  const ticks = Array.from({ length: DIAL_MAX / DIAL_STEP }, (_, i) => i);
  return <div ref={ref} className={styles.dial} role="slider" tabIndex={0} aria-label="Session length" aria-valuemin={DIAL_STEP} aria-valuemax={DIAL_MAX} aria-valuenow={minutes} aria-valuetext={`${minutes} minutes, until ${until(minutes)}`}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onKeyDown={onKeyDown}>
    <svg className={styles.dialSvg} viewBox="0 0 200 200" aria-hidden="true">
      {ticks.map(i => {
        const major = i % 3 === 0;
        const a = (i / ticks.length) * Math.PI * 2;
        const r1 = major ? 76 : 80;
        return <line key={i} className={styles.dialTick} data-major={major || undefined} x1={100 + Math.sin(a) * r1} y1={100 - Math.cos(a) * r1} x2={100 + Math.sin(a) * 86} y2={100 - Math.cos(a) * 86} />;
      })}
      <circle className={styles.dialTrack} cx="100" cy="100" r="94" />
      <motion.circle className={styles.dialArc} cx="100" cy="100" r="94" style={{ pathLength: arc, rotate: -90 }} />
    </svg>
    <motion.div className={styles.dialKnobArm} style={{ rotate: turn }} aria-hidden="true"><span className={styles.dialKnob} /></motion.div>
    <div className={styles.dialCenter} aria-hidden="true">
      <span className={styles.dialCount}><motion.span>{count}</motion.span><span className={styles.dialUnit}>min</span></span>
      <motion.span className={styles.dialUntil}>{end}</motion.span>
    </div>
  </div>;
}

export function ControlCenter({ focusModes, channels, people = [], defaultVolume = 60, defaultTextSize = 100, formatTime = defaultFormat, onStateChange, label = "Quick settings", className }: ControlCenterProps) {
  const reduced = useReducedMotion() ?? false;
  const titleId = useId();
  const [state, setState] = useState<ControlCenterState>(() => ({
    focus: null,
    notifications: true,
    channels: Object.fromEntries(channels.map(channel => [channel.id, channel.defaultOn ?? true])),
    presenting: false,
    volume: clamp(defaultVolume, 0, 100),
    textSize: clamp(defaultTextSize, TEXT_MIN, TEXT_MAX),
  }));
  const [open, setOpen] = useState<PanelId | null>(null);
  // Draft values for the focus panel, and the clock they count from, captured when the panel opens.
  const [draft, setDraft] = useState({ mode: focusModes[0]?.id ?? "", minutes: focusModes[0]?.defaultMinutes ?? 45, startedAt: 0 });
  const expandRefs = useRef<Record<PanelId, HTMLButtonElement | null>>({ focus: null, notifications: null });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastOpen = useRef<PanelId | null>(null);

  function update(patch: Partial<ControlCenterState>) {
    const next = { ...state, ...patch };
    setState(next);
    onStateChange?.(next);
  }
  const untilFor = (minutes: number) => formatTime(new Date(draft.startedAt + minutes * 60_000));

  function openPanel(panel: PanelId) {
    if (panel === "focus") {
      const current = state.focus;
      const mode = focusModes.find(item => item.id === current?.mode) ?? focusModes[0];
      setDraft({ mode: mode?.id ?? "", minutes: current?.minutes ?? mode?.defaultMinutes ?? 45, startedAt: Date.now() });
    }
    lastOpen.current = panel;
    setOpen(panel);
  }
  function close() { setOpen(null); }

  // Focus moves into the panel when it opens and returns to the chevron that opened it.
  useEffect(() => {
    if (open) { closeRef.current?.focus({ preventScroll: true }); return; }
    const last = lastOpen.current;
    if (!last) return;
    const frame = requestAnimationFrame(() => expandRefs.current[last]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function onDialogKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function toggleFocus() {
    if (state.focus) { update({ focus: null }); return; }
    const mode = focusModes[0];
    if (!mode) return;
    update({ focus: { mode: mode.id, minutes: mode.defaultMinutes, until: formatTime(new Date(Date.now() + mode.defaultMinutes * 60_000)) } });
  }
  function startFocus() {
    update({ focus: { mode: draft.mode, minutes: draft.minutes, until: untilFor(draft.minutes) } });
    close();
  }

  const activeMode = focusModes.find(item => item.id === state.focus?.mode);
  const draftMode = focusModes.find(item => item.id === draft.mode) ?? focusModes[0];
  const focusIcon = (open === "focus" ? draftMode : activeMode ?? focusModes[0])?.icon ?? MonitorUp;
  const onChannels = channels.filter(channel => state.channels[channel.id]).length;
  const VolumeIcon = state.volume === 0 ? VolumeX : state.volume < 50 ? Volume1 : Volume2;
  const panelTransition = reduced ? { duration: motionTokens.duration.fast } : motionTokens.spring.morph;

  return <MotionConfig reducedMotion="user" transition={motionTokens.spring.morph}>
    <section className={[styles.panel, className].filter(Boolean).join(" ")} aria-label={label} data-expanded={open ? "" : undefined}>
      <LayoutGroup>
        <div className={styles.grid} aria-hidden={open ? true : undefined} inert={open ? true : undefined}>
          <Tile id="focus" wide icon={focusIcon} iconKey={activeMode?.id ?? "off"} title={activeMode ? activeMode.label : "Focus"}
            status={state.focus ? `Until ${state.focus.until}` : "Off"} active={!!state.focus} open={open === "focus"}
            onPress={toggleFocus} onExpand={() => openPanel("focus")} expandLabel="Focus session settings" registerExpand={node => { expandRefs.current.focus = node; }} />
          <Tile id="notifications" icon={state.notifications ? Bell : BellOff} iconKey={state.notifications ? "on" : "off"} title="Notifications"
            status={state.notifications ? `${onChannels} of ${channels.length} channels` : "Paused"} active={state.notifications} open={open === "notifications"}
            onPress={() => update({ notifications: !state.notifications })} onExpand={() => openPanel("notifications")} expandLabel="Notification channels" registerExpand={node => { expandRefs.current.notifications = node; }} />
          <Tile id="presenting" icon={Presentation} iconKey="presenting" title="Presenting" status={state.presenting ? "Previews hidden" : "Off"} active={state.presenting} open={false}
            onPress={() => update({ presenting: !state.presenting })} />
          <div className={styles.meters}>
            <Meter label="Alert volume" value={state.volume} min={0} max={100} step={1} segments={28} format={v => `${v}%`}
              icon={<SwapIcon icon={VolumeIcon} swapKey={state.volume === 0 ? "mute" : state.volume < 50 ? "low" : "high"} size={16} />}
              onChange={volume => update({ volume })} />
            <Meter label="Text size" value={state.textSize} min={TEXT_MIN} max={TEXT_MAX} step={5} segments={28} format={v => `${v}%`}
              icon={<Type size={16} strokeWidth={1.75} />}
              trailing={progress => <TextPreview progress={progress} />}
              onChange={textSize => update({ textSize })} />
          </div>
        </div>

        <AnimatePresence>
          {open && <motion.div key="scrim" className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.standard }} onClick={close} aria-hidden="true" />}
          {open && <motion.div key={open} ref={dialogRef} layoutId={`cc-${open}`} className={styles.detail} role="dialog" aria-modal="true" aria-labelledby={titleId}
            style={{ borderRadius: 22 }} transition={panelTransition} onKeyDown={onDialogKey}>
            <div className={styles.detailHead}>
              <motion.span layoutId={`cc-${open}-icon`} layout="position" className={styles.tileIcon} data-active={(open === "focus" ? true : state.notifications) || undefined}>
                {open === "focus" ? <SwapIcon icon={draftMode?.icon ?? MonitorUp} swapKey={draft.mode} /> : <SwapIcon icon={state.notifications ? Bell : BellOff} swapKey={state.notifications ? "on" : "off"} />}
              </motion.span>
              <motion.h3 layoutId={`cc-${open}-title`} layout="position" id={titleId} className={styles.detailTitle}>{open === "focus" ? "Focus" : "Notifications"}</motion.h3>
              <motion.button layoutId={`cc-${open}-action`} layout="position" ref={closeRef} type="button" className={styles.close} aria-label="Close" onClick={close}><X size={16} strokeWidth={1.75} aria-hidden="true" /></motion.button>
            </div>
            <motion.div layout="position" className={styles.detailBody} initial={{ opacity: 0, y: reduced ? 0 : 10 }} animate={{ opacity: 1, y: 0, transition: { delay: reduced ? 0 : .08, duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant } }}>
              {open === "focus" ? <>
                <div className={styles.modes} role="radiogroup" aria-label="Mode">
                  {focusModes.map(mode => {
                    const selected = mode.id === draft.mode;
                    return <button key={mode.id} type="button" role="radio" aria-checked={selected} className={styles.mode}
                      onClick={() => setDraft(previous => ({ ...previous, mode: mode.id, minutes: previous.mode === mode.id ? previous.minutes : mode.defaultMinutes }))}>
                      {selected && <motion.span layoutId="cc-mode-highlight" className={styles.modeHighlight} transition={motionTokens.spring.morph} />}
                      <span className={styles.modeLabel}>{mode.label}</span>
                    </button>;
                  })}
                </div>
                <p className={styles.modeNote}><RollText text={draftMode?.description ?? ""} /></p>
                <FocusDial minutes={draft.minutes} until={untilFor} onChange={minutes => setDraft(previous => ({ ...previous, minutes }))} />
                <div className={styles.actions}>
                  {state.focus && <button type="button" className={styles.secondary} onClick={() => { update({ focus: null }); close(); }}>End session</button>}
                  <button type="button" className={styles.primary} onClick={startFocus}>{state.focus ? "Update session" : "Start session"}</button>
                </div>
              </> : <>
                <Switch label="All notifications" description={state.notifications ? "Delivered as they arrive" : "Paused until you resume"} checked={state.notifications} onChange={notifications => update({ notifications })} />
                <div className={styles.channels} data-muted={!state.notifications || undefined}>
                  {channels.map(channel => <Switch key={channel.id} label={channel.label} description={channel.description} checked={state.channels[channel.id]}
                    onChange={on => update({ channels: { ...state.channels, [channel.id]: on } })} />)}
                </div>
                {people.length > 0 && <div className={styles.people}>
                  <span className={styles.avatars} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic. */}
                    {people.slice(0, 3).map(person => <img key={person.id} src={person.avatar} alt="" width={28} height={28} draggable={false} />)}
                  </span>
                  <span className={styles.peopleText}>{people.map(person => person.name.split(" ")[0]).join(", ")} can reach you during focus</span>
                </div>}
              </>}
            </motion.div>
          </motion.div>}
        </AnimatePresence>
      </LayoutGroup>
    </section>
  </MotionConfig>;
}

/* The text size meter shows its result: a glyph that grows with the fill. */
function TextPreview({ progress }: { progress: MotionValue<number> }) {
  const scale = useTransform(progress, p => (TEXT_MIN + clamp(p, 0, 1) * (TEXT_MAX - TEXT_MIN)) / 100);
  return <span className={styles.textPreview} aria-hidden="true"><motion.span style={{ scale }}>Aa</motion.span></span>;
}

export default ControlCenter;
