"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, MotionConfig, animate, motion, useAnimationFrame, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { MotionProps, MotionValue } from "motion/react";
import { ChevronDown, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./now-playing.module.css";

export interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
  /** Length in seconds. */
  duration: number;
  artwork: string;
  artworkAlt?: string;
}

/** A compact player that grows from a mini bar into a full player in one continuous morph. The waveform scrubs 1:1 under the pointer and by arrow keys; artwork slides in the direction you skip. Playback is driven by a clock, so wire `onPlayingChange` and `onIndexChange` to real audio. */
export interface NowPlayingProps {
  tracks: NowPlayingTrack[];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  playing?: boolean;
  defaultPlaying?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  defaultExpanded?: boolean;
  label?: string;
  className?: string;
}

const BARS = 54;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function rubberband(overshoot: number, dimension: number, constant = .55) {
  const distance = Math.abs(overshoot);
  return Math.sign(overshoot) * (distance * dimension * constant) / (dimension + constant * distance);
}
/** Deterministic peaks per track, shaped like a song: a soft intro, a fuller middle, and a tail. */
function peaksFor(id: string) {
  let seed = 0;
  for (const char of id) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: BARS }, (_, i) => {
    const t = i / (BARS - 1);
    const envelope = .35 + .65 * Math.sin(Math.PI * clamp(t * 1.1, 0, 1)) ** .7;
    return clamp(envelope * (.45 + random() * .55), .12, 1);
  });
}

/** Three small level bars that dance while a track plays and rest while paused. */
export interface NowPlayingLevelsProps { playing: boolean; className?: string }
export function NowPlayingLevels({ playing, className }: NowPlayingLevelsProps) {
  return <span className={[styles.levels, className].filter(Boolean).join(" ")} data-playing={playing || undefined} aria-hidden="true"><span /><span /><span /></span>;
}

function Waveform({ track, progress, onSeek }: { track: NowPlayingTrack; progress: MotionValue<number>; onSeek: (value: number) => void }) {
  const peaks = peaksFor(track.id);
  const clip = useTransform(progress, p => `inset(0 ${(1 - p) * 100}% 0 0)`);
  const stretch = useMotionValue(0);
  const lift = useMotionValue(1);
  const drag = useRef<{ pointer: number; left: number; width: number } | null>(null);
  const [now, setNow] = useState(() => Math.floor(progress.get() * track.duration));
  useMotionValueEvent(progress, "change", p => setNow(Math.floor(p * track.duration)));

  function seekTo(clientX: number) {
    const state = drag.current!;
    const raw = (clientX - state.left) / state.width;
    progress.set(clamp(raw, 0, 1));
    stretch.set(raw < 0 ? rubberband(raw * state.width, state.width, .3) : raw > 1 ? rubberband((raw - 1) * state.width, state.width, .3) : 0);
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, left: rect.left, width: rect.width };
    animate(lift, 1.18, motionTokens.spring.snappy);
    seekTo(event.clientX);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer === event.pointerId) seekTo(event.clientX);
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    animate(lift, 1, motionTokens.spring.snappy);
    animate(stretch, 0, { type: "spring", visualDuration: .4, bounce: .2 });
    onSeek(progress.get());
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = 5 / track.duration;
    const map: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 6, PageDown: -step * 6, Home: -1, End: 1 };
    if (!(event.key in map)) return;
    event.preventDefault();
    const next = clamp(progress.get() + map[event.key], 0, .999);
    progress.set(next);
    onSeek(next);
  }

  const bars = peaks.map((peak, i) => <span key={i} style={{ height: `${peak * 100}%` }} />);
  return <div className={styles.scrubber}>
    <motion.div className={styles.wave} role="slider" tabIndex={0} aria-label="Position" aria-valuemin={0} aria-valuemax={track.duration} aria-valuenow={now}
      aria-valuetext={`${clock(now)} of ${clock(track.duration)}`} style={{ x: stretch, scaleY: lift }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onKeyDown={onKeyDown}>
      <span className={styles.bars} aria-hidden="true">{bars}</span>
      <motion.span className={styles.bars} data-played aria-hidden="true" style={{ clipPath: clip }}>{bars}</motion.span>
    </motion.div>
    <div className={styles.times} aria-hidden="true">
      <span>{clock(now)}</span>
      <span>−{clock(Math.max(0, track.duration - now))}</span>
    </div>
  </div>;
}

export function NowPlaying({ tracks, index: indexProp, defaultIndex = 0, onIndexChange, playing: playingProp, defaultPlaying = false, onPlayingChange, defaultExpanded = false, label = "Now playing", className }: NowPlayingProps) {
  const reduced = useReducedMotion() ?? false;
  const regionId = useId();
  const [ownIndex, setOwnIndex] = useState(defaultIndex);
  const [ownPlaying, setOwnPlaying] = useState(defaultPlaying);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [direction, setDirection] = useState(1);
  const index = clamp(indexProp ?? ownIndex, 0, tracks.length - 1);
  const playing = playingProp ?? ownPlaying;
  const track = tracks[index];
  const progress = useMotionValue(0);
  const pull = useMotionValue(0);
  const pullGesture = useRef<{ pointer: number; y: number; lastY: number; lastT: number; velocity: number } | null>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  const innerRef = useRef<HTMLDivElement>(null);
  // The shell follows its content's natural height on a spring. Until the first measurement it simply sizes to its content.
  const height = useMotionValue<number | "auto">("auto");
  const heightTransition = useRef<{ reduced: boolean; expanded: boolean }>({ reduced, expanded });
  useEffect(() => { heightTransition.current = { reduced, expanded }; });
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      const next = inner.offsetHeight, current = height.get();
      if (typeof current !== "number") { height.jump(next); return; }
      if (Math.abs(current - next) < .5) return;
      const { reduced: calm, expanded: open } = heightTransition.current;
      animate(height, next, calm ? { duration: motionTokens.duration.fast } : { type: "spring", visualDuration: .46, bounce: open ? .1 : 0 });
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [height]);
  const live = useRef({ playing, index, count: tracks.length, duration: track.duration });

  useEffect(() => { live.current = { playing, index, count: tracks.length, duration: track.duration }; });

  function setPlaying(next: boolean) { setOwnPlaying(next); onPlayingChange?.(next); }
  function go(delta: number) {
    // Back restarts the track when it is a few seconds in, like a transport should.
    if (delta < 0 && progress.get() * track.duration > 3) { animate(progress, 0, reduced ? { duration: 0 } : motionTokens.spring.smooth); return; }
    const next = (index + delta + tracks.length) % tracks.length;
    setDirection(delta);
    progress.set(0);
    setOwnIndex(next);
    onIndexChange?.(next);
  }

  // A simulated clock advances the position while playing and rolls into the next track at the end.
  useAnimationFrame((_, delta) => {
    const state = live.current;
    if (!state.playing || pullGesture.current) return;
    const next = progress.get() + delta / 1000 / state.duration;
    if (next < 1) { progress.set(next); return; }
    const following = (state.index + 1) % state.count;
    progress.set(0);
    setDirection(1);
    setOwnIndex(following);
    onIndexChange?.(following);
  });

  // Focus follows the morph: into the full player on open, back to the bar on close.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    (expanded ? collapseRef : expandRef).current?.focus({ preventScroll: true });
  }, [expanded]);

  function onPullDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pullGesture.current || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pull.stop();
    pullGesture.current = { pointer: event.pointerId, y: event.clientY, lastY: event.clientY, lastT: event.timeStamp, velocity: 0 };
  }
  function onPullMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pullGesture.current;
    if (!state || state.pointer !== event.pointerId) return;
    const dy = event.clientY - state.y;
    // Down follows the finger with light resistance; up barely moves.
    pull.set(dy > 0 ? dy * .6 : rubberband(dy, 200, .2));
    state.velocity = (event.clientY - state.lastY) / Math.max(1, event.timeStamp - state.lastT);
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
  }
  function onPullEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pullGesture.current;
    if (!state || state.pointer !== event.pointerId) return;
    pullGesture.current = null;
    // A long pull or a quick flick down closes; anything else springs back.
    const closing = pull.get() > 70 || state.velocity > .5;
    if (closing) setExpanded(false);
    animate(pull, 0, { type: "spring", visualDuration: .4, bounce: closing ? 0 : .25 });
  }

  // One spring drives every moving part of the morph, so the shell, the artwork, and the buttons arrive together.
  // Opening may overshoot a hair; closing never does, so the bar settles without a wobble.
  const morph = reduced ? { duration: motionTokens.duration.fast } : { type: "spring" as const, visualDuration: .46, bounce: expanded ? .1 : 0 };
  const artVariants = {
    enter: (d: number) => reduced ? { opacity: 0 } : { opacity: 0, x: `${d * 24}%`, scale: .96, filter: `blur(${motionTokens.blur.soft}px)` },
    center: { opacity: 1, x: "0%", scale: 1, filter: "blur(0px)" },
    exit: (d: number) => reduced ? { opacity: 0 } : { opacity: 0, x: `${d * -24}%`, scale: .96, filter: `blur(${motionTokens.blur.soft}px)` },
  };
  const PlayIcon = playing ? Pause : Play;
  const playLabel = `${playing ? "Pause" : "Play"} ${track.title}`;
  const textSwap: MotionProps = { initial: { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, y: -6, transition: { duration: motionTokens.duration.instant } }, transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } };
  // Parts that belong to one state leave quickly, before the shell has moved far, and the new state's parts arrive once it is well on its way.
  const appear = (delay: number, rise = 8): MotionProps => ({
    initial: { opacity: 0, y: reduced ? 0 : rise, filter: reduced ? "blur(0px)" : `blur(${motionTokens.blur.subtle}px)` },
    animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter], delay: reduced ? 0 : delay } },
    exit: { opacity: 0, filter: reduced ? "blur(0px)" : `blur(${motionTokens.blur.subtle}px)`, transition: { duration: reduced ? motionTokens.duration.instant : .1, ease: [...motionTokens.ease.exit] } },
  });

  return <MotionConfig reducedMotion="user">
    <section className={[styles.root, className].filter(Boolean).join(" ")} aria-label={label} aria-describedby={regionId}
      onKeyDown={event => { if (event.key === "Escape" && expanded) { event.stopPropagation(); setExpanded(false); } }}>
      <p id={regionId} className={styles.srOnly} aria-live="polite">{track.title} by {track.artist}, {playing ? "playing" : "paused"}</p>
      {/* The shell animates its real height and corner radius, never a scale, so nothing inside it is squashed on the way. */}
      <motion.div className={styles.shell} data-expanded={expanded || undefined} initial={false} animate={{ borderRadius: expanded ? 30 : 22 }} style={{ y: pull, height }} transition={morph}>
        <div ref={innerRef} className={styles.inner}>
          {/* The artwork is one element in both states. Its image is square and cropped by the frame, so it only ever scales evenly. */}
          <motion.div layout className={styles.art} initial={false} animate={{ borderRadius: expanded ? 20 : 12 }} transition={morph}
            onPointerDown={expanded ? onPullDown : undefined} onPointerMove={expanded ? onPullMove : undefined} onPointerUp={expanded ? onPullEnd : undefined} onPointerCancel={expanded ? onPullEnd : undefined}>
            <motion.div layout className={styles.artSquare} transition={morph}>
              <AnimatePresence initial={false} custom={direction}>
                <motion.img key={track.id} className={styles.artImage} src={track.artwork} alt={track.artworkAlt ?? ""} draggable={false} decoding="async"
                  custom={direction} variants={artVariants} initial="enter" animate="center" exit="exit" transition={{ ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } }} />
              </AnimatePresence>
            </motion.div>
            <AnimatePresence initial={false}>
              {expanded && <motion.button key="collapse" ref={collapseRef} type="button" className={styles.collapse} aria-label="Collapse player" aria-expanded="true" onClick={() => setExpanded(false)}
                onPointerDown={event => event.stopPropagation()} {...appear(.16, 0)}>
                <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
              </motion.button>}
            </AnimatePresence>
          </motion.div>

          <AnimatePresence initial={false} mode="popLayout">
            {expanded ? [
              <motion.div key="info" className={styles.info} {...appear(.08, 12)}>
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div key={track.id} className={styles.infoText} {...textSwap}>
                    <h3 className={styles.titleLarge}>{track.title}</h3>
                    <p className={styles.artistLarge}>{track.artist}</p>
                  </motion.div>
                </AnimatePresence>
              </motion.div>,
              <motion.div key="wave" className={styles.waveArea} {...appear(.12, 14)}>
                <Waveform key={track.id} track={track} progress={progress} onSeek={value => progress.set(value)} />
              </motion.div>,
              <motion.button key="prev" type="button" className={styles.prev} aria-label="Previous track" onClick={() => go(-1)} {...appear(.14, 10)}>
                <SkipBack size={20} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
              </motion.button>,
            ] : [
              <motion.button key="main" ref={expandRef} type="button" className={styles.miniMain} aria-label={`Expand player, ${track.title} by ${track.artist}`} aria-expanded="false" onClick={() => setExpanded(true)} {...appear(.1, 4)}>
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span key={track.id} className={styles.miniText} {...textSwap}>
                    <span className={styles.miniTitle}>{track.title}</span>
                    <span className={styles.miniArtist}>{track.artist}</span>
                  </motion.span>
                </AnimatePresence>
              </motion.button>,
              <motion.span key="levels" className={styles.levelsArea} {...appear(.14, 0)}><NowPlayingLevels playing={playing} /></motion.span>,
              <motion.span key="progress" className={styles.miniProgressTrack} aria-hidden="true" {...appear(.16, 0)}>
                <motion.span className={styles.miniProgress} style={{ scaleX: progress }} />
              </motion.span>,
            ]}
          </AnimatePresence>

          {/* Play and next travel between the bar and the transport as themselves, so there is never a second copy to fade. */}
          <motion.button layout type="button" className={styles.play} aria-label={playLabel} onClick={() => setPlaying(!playing)} transition={morph}>
            <PlayIconSwap icon={PlayIcon} playing={playing} size={expanded ? 24 : 18} />
          </motion.button>
          <motion.button layout type="button" className={styles.next} aria-label="Next track" onClick={() => go(1)} transition={morph}>
            <SkipForward size={expanded ? 20 : 18} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
          </motion.button>
        </div>
      </motion.div>
    </section>
  </MotionConfig>;
}

function PlayIconSwap({ icon: Icon, playing, size }: { icon: typeof Play; playing: boolean; size: number }) {
  return <span className={styles.playGlyph} style={{ width: size, height: size }}>
    <AnimatePresence initial={false}>
      <motion.span key={playing ? "pause" : "play"} className={styles.playPhase} data-icon={playing ? "pause" : "play"}
        initial={{ opacity: 0, scale: .6, filter: `blur(${motionTokens.blur.subtle}px)` }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: .6, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant } }} transition={motionTokens.spring.snappy}>
        <Icon size={size} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
      </motion.span>
    </AnimatePresence>
  </span>;
}

export default NowPlaying;
