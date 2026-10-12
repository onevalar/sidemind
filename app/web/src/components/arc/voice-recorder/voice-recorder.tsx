"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { ArrowUp, Mic, Pause, Play, Square, Trash2 } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./voice-recorder.module.css";

export interface VoiceMessage {
  id: string;
  /** Length in seconds. */
  duration: number;
  /** Bar heights between 0 and 1. */
  peaks: number[];
  /** Sender name for incoming messages. Leave empty for your own. */
  from?: string;
  /** Sender portrait for incoming messages. */
  avatar?: string;
  /** Short line under the bubble, such as "9:41 AM". */
  meta?: string;
}

/** A voice note composer and thread. The mic grows into a live recording bar with a scrolling waveform and a tabular timer, stops into a review you can play and scrub, and sends by morphing the take into the thread. Recording is simulated; wire `onSend` to real audio. */
export interface VoiceRecorderProps {
  defaultMessages?: VoiceMessage[];
  onSend?: (message: VoiceMessage) => void;
  /** Called when a take is discarded. */
  onCancel?: () => void;
  /** Seconds before recording stops on its own. */
  maxDuration?: number;
  /** Meta line on messages you send. */
  sentMeta?: string;
  label?: string;
  className?: string;
}

type Phase = "idle" | "recording" | "review";

const STEP = 90;
const PITCH = 5;
const BAR = 3;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const grain = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** A deterministic, speech like level for a sample: syllables inside phrases, with short pauses between words. */
export function voiceLevel(index: number, seed = 0) {
  const t = index + seed * 97;
  const phrase = .55 + .45 * Math.sin(t * .05 + seed);
  const syllable = Math.abs(Math.sin(t * .55 + Math.sin(t * .13) * 1.7));
  const pause = Math.sin(t * .085 + seed * 1.3) > .8 ? .14 : 1;
  return clamp((.22 + .78 * syllable) * phrase * pause * (.62 + .38 * grain(t)), .07, 1);
}
const barsFor = (seconds: number) => Math.round(clamp(14 + seconds * 1.3, 18, 36));
/** Downsamples the same levels the live waveform drew, so a sent bubble looks like what was recorded. */
export function voicePeaks(seed: number, seconds: number, bars = barsFor(seconds)) {
  const samples = Math.max(bars, Math.round(seconds * 1000 / STEP));
  return Array.from({ length: bars }, (_, bar) => {
    const from = Math.floor(bar * samples / bars), to = Math.max(from + 1, Math.floor((bar + 1) * samples / bars));
    let peak = 0;
    for (let index = from; index < to; index++) peak = Math.max(peak, voiceLevel(index, seed));
    return Math.round(peak * 100) / 100;
  });
}

/** Paints the live waveform: each sample enters at the right edge, grows to its level, and scrolls left at a constant speed. */
function paint(canvas: HTMLCanvasElement | null, elapsed: number, seed: number, stepped: boolean) {
  if (!canvas) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(canvas).color;
  const time = stepped ? Math.floor(elapsed / STEP) * STEP : elapsed;
  const newest = Math.floor(time / STEP);
  const visible = Math.ceil(width / PITCH) + 2;
  for (let i = newest; i > newest - visible && i >= 0; i--) {
    const age = time - i * STEP;
    const x = width - 2 - (age / STEP) * PITCH;
    if (x < -BAR) break;
    const grow = stepped ? 1 : clamp(age / 140, 0, 1);
    const h = Math.max(BAR, voiceLevel(i, seed) * (height - 4) * grow);
    // Older samples fade toward the left edge so the bar reads as time passing.
    context.globalAlpha = clamp(x / (width * .25), .25, 1);
    context.beginPath();
    context.roundRect(x, (height - h) / 2, BAR, h, BAR / 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

function Bars({ peaks, progress, className }: { peaks: number[]; progress: MotionValue<number>; className?: string }) {
  const clip = useTransform(progress, p => `inset(0 ${(1 - clamp(p, 0, 1)) * 100}% 0 0)`);
  const bars = peaks.map((peak, i) => <span key={i} style={{ height: `${Math.max(12, peak * 100)}%` }} />);
  return <span className={[styles.bars, className].filter(Boolean).join(" ")} aria-hidden="true">
    <span className={styles.barsLayer}>{bars}</span>
    <motion.span className={styles.barsLayer} data-played style={{ clipPath: clip }}>{bars}</motion.span>
  </span>;
}

/** Plays a take on a clock: returns the progress value, whether it is playing, and a toggle. */
function usePlayback(duration: number) {
  const progress = useMotionValue(0);
  const [playing, setPlaying] = useState(false);
  const live = useRef({ playing, duration });
  useEffect(() => { live.current = { playing, duration }; });
  useAnimationFrame((_, delta) => {
    if (!live.current.playing) return;
    const next = progress.get() + delta / 1000 / live.current.duration;
    if (next >= 1) { progress.set(1); setPlaying(false); return; }
    progress.set(next);
  });
  function toggle() {
    if (!playing && progress.get() >= 1) progress.set(0);
    setPlaying(!playing);
  }
  return { progress, playing, toggle, setPlaying };
}

function Message({ message, layoutId }: { message: VoiceMessage; layoutId?: string }) {
  const { progress, playing, toggle } = usePlayback(message.duration);
  const [now, setNow] = useState(0);
  useEffect(() => progress.on("change", p => setNow(Math.floor(p * message.duration))), [progress, message.duration]);
  const mine = !message.from;
  const label = `${playing ? "Pause" : "Play"} voice message${message.from ? ` from ${message.from}` : ""}, ${clock(message.duration)}`;

  function seek(event: ReactPointerEvent<HTMLSpanElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    progress.set(clamp((event.clientX - rect.left) / rect.width, 0, 1));
  }
  return <li className={styles.message} data-mine={mine || undefined}>
    {!mine && (message.avatar
      // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic.
      ? <img className={styles.avatar} src={message.avatar} alt="" width={28} height={28} draggable={false} />
      : <span className={styles.avatar} aria-hidden="true" />)}
    <div className={styles.messageBody}>
      <motion.div layoutId={layoutId} className={styles.bubble} style={{ borderRadius: 22 }} transition={motionTokens.spring.morph}>
        {/* Layout children are scale corrected, so the play button, bars, and time keep their shape while the bubble morphs. */}
        <motion.button layout="position" type="button" className={styles.bubblePlay} aria-label={label} onClick={toggle} transition={motionTokens.spring.morph}>
          {playing ? <Pause size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" /> : <Play size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />}
        </motion.button>
        <motion.span layout="position" className={styles.bubbleWave} onPointerDown={seek} transition={motionTokens.spring.morph}>
          <Bars peaks={message.peaks} progress={progress} />
        </motion.span>
        <motion.span layout="position" className={styles.bubbleTime} transition={motionTokens.spring.morph}>{clock(playing || now > 0 ? now : message.duration)}</motion.span>
      </motion.div>
      {message.meta && <span className={styles.meta}>{message.meta}</span>}
    </div>
  </li>;
}

export function VoiceRecorder({ defaultMessages = [], onSend, onCancel, maxDuration = 60, sentMeta = "Just now", label = "Voice messages", className }: VoiceRecorderProps) {
  const reduced = useReducedMotion() ?? false;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const statusId = `${uid}-status`;
  const [messages, setMessages] = useState(defaultMessages);
  const [phase, setPhase] = useState<Phase>("idle");
  // Takes are numbered so the mic can wear the next take's layout id: mic, recording bar, review, and sent bubble are one shape.
  const [takeCount, setTakeCount] = useState(0);
  const [take, setTake] = useState({ seed: 1, duration: 0 });
  const takeId = (n: number) => `${uid}-take-${n}`;
  const [status, setStatus] = useState("");
  // A mic that returns after a send pops in fresh; one that a discarded take folds back into is already on screen, so it only morphs.
  const [micEntry, setMicEntry] = useState<"fold" | "pop">("fold");
  const [shownSeconds, setShownSeconds] = useState(0);
  const elapsed = useMotionValue(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threadRef = useRef<HTMLOListElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef(phase);
  const mounted = useRef(false);
  const review = usePlayback(Math.max(1, take.duration));
  const timer = useTransform(elapsed, ms => `${clock(ms / 1000)}.${Math.floor((ms % 1000) / 100)}`);
  const reviewTime = useTransform(review.progress, p => clock(p * take.duration));

  useEffect(() => { phaseRef.current = phase; });

  // The live clock: advances the take, paints the waveform, and stops the take at the limit.
  useAnimationFrame((_, delta) => {
    if (phaseRef.current !== "recording") return;
    const next = Math.min(elapsed.get() + delta, maxDuration * 1000);
    elapsed.set(next);
    paint(canvasRef.current, next, take.seed, reduced);
    const seconds = Math.floor(next / 1000);
    if (seconds !== shownSeconds) setShownSeconds(seconds);
    if (next >= maxDuration * 1000) stop();
  });

  // Focus follows the composer: mic, then stop, then send, then back to the mic.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    primaryRef.current?.focus({ preventScroll: true });
  }, [phase]);
  // New messages scroll into view at the bottom of the thread.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages.length, reduced]);

  function start() {
    const next = takeCount + 1;
    elapsed.set(0);
    setShownSeconds(0);
    setTakeCount(next);
    setTake({ seed: next * 7 + 3, duration: 0 });
    setStatus("Recording");
    setPhase("recording");
  }
  function stop() {
    const seconds = Math.max(1, Math.round(elapsed.get() / 100) / 10);
    phaseRef.current = "review";
    setTake(previous => ({ ...previous, duration: seconds }));
    review.progress.set(0);
    review.setPlaying(false);
    setStatus(`Recorded ${clock(seconds)}. Play it back or send it.`);
    setPhase("review");
  }
  function discard() {
    phaseRef.current = "idle";
    review.setPlaying(false);
    // Hand the id back so the bar folds into the mic it came from.
    setTakeCount(count => count - 1);
    setMicEntry("fold");
    setStatus("Voice note discarded");
    setPhase("idle");
    onCancel?.();
  }
  function send() {
    const message: VoiceMessage = { id: takeId(takeCount), duration: take.duration, peaks: voicePeaks(take.seed, take.duration), meta: sentMeta };
    review.setPlaying(false);
    setMessages(previous => [...previous, message]);
    setMicEntry("pop");
    setStatus("Voice note sent");
    setPhase("idle");
    onSend?.(message);
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && phase !== "idle") { event.preventDefault(); discard(); }
  }

  const swap = { initial: { opacity: 0, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: motionTokens.ease.standard, delay: reduced ? 0 : .05 } }, exit: { opacity: 0, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: motionTokens.ease.exit } } };
  const sideButton = { initial: { opacity: 0, scale: .7 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: .7, transition: { duration: motionTokens.duration.instant } }, transition: motionTokens.spring.snappy };

  return <MotionConfig reducedMotion="user">
    <section className={[styles.root, className].filter(Boolean).join(" ")} aria-label={label}>
      <LayoutGroup>
        <ol ref={threadRef} className={styles.thread} aria-label="Messages">
          {messages.map(message => <Message key={message.id} message={message} layoutId={`vr-${message.id}`} />)}
        </ol>

        <div className={styles.composer} data-phase={phase} onKeyDown={onKeyDown}>
          <AnimatePresence initial={false} mode="popLayout">
            {phase === "idle" && <motion.span key="hint" className={styles.hint} {...swap}>Tap the mic to record a voice note</motion.span>}
          </AnimatePresence>

          <AnimatePresence initial={false} mode="popLayout">
            {phase !== "idle" && <motion.button key="discard" type="button" className={styles.discard} aria-label="Discard voice note" onClick={discard} {...sideButton}>
              <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
            </motion.button>}
          </AnimatePresence>

          {phase === "idle"
            ? <motion.button key="mic" ref={primaryRef} layoutId={`vr-${takeId(takeCount + 1)}`} type="button" className={styles.mic} aria-label="Record voice note" aria-describedby={statusId} onClick={start}
                initial={micEntry === "pop" ? { opacity: 0, scale: .8 } : false} animate={{ opacity: 1, scale: 1 }} style={{ borderRadius: 999 }} transition={motionTokens.spring.morph}>
                <motion.span layout="position" className={styles.micIcon} transition={motionTokens.spring.morph}><Mic size={20} strokeWidth={1.75} aria-hidden="true" /></motion.span>
              </motion.button>
            : <motion.div layoutId={`vr-${takeId(takeCount)}`} className={styles.capsule} data-phase={phase} style={{ borderRadius: 999 }} transition={motionTokens.spring.morph}>
                <AnimatePresence initial={false} mode="popLayout">
                  {phase === "recording"
                    ? <motion.div key="recording" layout="position" className={styles.capsuleRow} {...swap}>
                        <span className={styles.recDot} aria-hidden="true" />
                        <motion.span className={styles.timer} aria-hidden="true">{timer}</motion.span>
                        <canvas ref={canvasRef} className={styles.live} aria-hidden="true" />
                      </motion.div>
                    : <motion.div key="review" layout="position" className={styles.capsuleRow} {...swap}>
                        <button type="button" className={styles.reviewPlay} aria-label={review.playing ? "Pause preview" : "Play preview"} onClick={review.toggle}>
                          {review.playing ? <Pause size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" /> : <Play size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />}
                        </button>
                        <span className={styles.reviewWave} onPointerDown={event => { const rect = event.currentTarget.getBoundingClientRect(); review.progress.set(clamp((event.clientX - rect.left) / rect.width, 0, 1)); }}>
                          <Bars peaks={voicePeaks(take.seed, take.duration, 40)} progress={review.progress} />
                        </span>
                        <motion.span className={styles.timer} aria-hidden="true">{review.playing ? reviewTime : clock(take.duration)}</motion.span>
                      </motion.div>}
                </AnimatePresence>
              </motion.div>}

          <AnimatePresence initial={false} mode="popLayout">
            {phase === "recording" && <motion.button key="stop" ref={primaryRef} type="button" className={styles.stop} aria-label={`Stop recording at ${clock(shownSeconds)}`} onClick={stop} {...sideButton}>
              <Square size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
            </motion.button>}
            {phase === "review" && <motion.button key="send" ref={primaryRef} type="button" className={styles.send} aria-label="Send voice note" onClick={send} {...sideButton}>
              <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
            </motion.button>}
          </AnimatePresence>
        </div>
      </LayoutGroup>
      <p id={statusId} className={styles.srOnly} aria-live="polite">{status}</p>
    </section>
  </MotionConfig>;
}

export default VoiceRecorder;
