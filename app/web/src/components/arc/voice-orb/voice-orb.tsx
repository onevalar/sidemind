"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { MotionValue, Transition } from "motion/react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./voice-orb.module.css";

export type VoiceOrbState = "idle" | "listening" | "thinking" | "speaking";

/**
 * The visual heart of a voice mode: a luminous fluid sphere in the accent colour, drawn by a small WebGL shader. Idle breathes
 * slowly, listening swells with the microphone level and sends soft ripples outward, thinking draws in and lets a band of light
 * orbit its rim, and speaking brightens and ripples with the voice. Every parameter follows its state on a spring, so changes
 * interrupt and blend mid-motion instead of cutting. Colours come from `--accent` (or `--voice-orb-tint` and
 * `--voice-orb-tint-2` on any ancestor) and update with the theme. It pauses while offscreen or hidden, falls back to a canvas
 * gradient without WebGL, and reduced motion draws one still frame per state.
 */
export interface VoiceOrbProps {
  state: VoiceOrbState;
  /** Microphone level from 0 to 1, read every frame while listening, such as `useMicLevel().level`. Simulated when omitted. */
  inputLevel?: MotionValue<number>;
  /** Voice level from 0 to 1 while speaking. A rhythmic speech envelope is used when omitted. */
  outputLevel?: MotionValue<number>;
  /** Calms and desaturates the orb while listening and ignores the input level. */
  muted?: boolean;
  /** Rendered size in px. The sphere fills about 60% of it; the rest holds its light and ripples. */
  size?: number;
  /** Accessible description. Defaults to a sentence about the state. */
  label?: string;
  className?: string;
}

type Params = { breath: number; wobble: number; flow: number; swirl: number; gain: number; ring: number; shimmer: number; halo: number; grow: number; mute: number };
const TARGETS: Record<VoiceOrbState, Params> = {
  idle: { breath: .028, wobble: .014, flow: .32, swirl: .1, gain: 0, ring: 0, shimmer: 0, halo: .55, grow: 0, mute: 0 },
  listening: { breath: .01, wobble: .022, flow: .7, swirl: .22, gain: .15, ring: 1, shimmer: 0, halo: .75, grow: .03, mute: 0 },
  thinking: { breath: .012, wobble: .03, flow: .55, swirl: 1.25, gain: 0, ring: 0, shimmer: 1, halo: .6, grow: -.08, mute: 0 },
  speaking: { breath: .006, wobble: .026, flow: .95, swirl: .3, gain: .19, ring: 0, shimmer: 0, halo: .9, grow: .02, mute: 0 },
};
const MUTED: Params = { ...TARGETS.listening, gain: 0, ring: 0, flow: .25, wobble: .01, halo: .3, grow: -.02, mute: 1 };
const KEYS = Object.keys(TARGETS.idle) as (keyof Params)[];
const LABELS: Record<VoiceOrbState, string> = { idle: "Voice assistant is idle", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };

type RGB = [number, number, number];
interface Palette { c1: RGB; c2: RGB; c3: RGB; dark: boolean }
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a).toFixed(3)})`;

/** Turns the hue of a colour by `degrees` and lifts its lightness, keeping its saturation, for the second current in the fluid. */
function shift([r, g, b]: RGB, degrees: number, lift: number): RGB {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (d < 1e-4) return mix([r, g, b], [255, 255, 255], lift);
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = ((h * 60 + degrees) % 360 + 360) % 360;
  const L = clamp(l + lift * (1 - l)), C = (1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs((h / 60) % 2 - 1)), m = L - C / 2;
  const [a, b2, c] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return [(a + m) * 255, (b2 + m) * 255, (c + m) * 255];
}

/** Resolves CSS colours in any syntax (oklch, color-mix, hex) to RGB by painting one pixel, then derives the fluid's three tones. */
function readPalette(node: HTMLElement): Palette {
  const style = getComputedStyle(node);
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  const read = (names: string[], fallback: RGB): RGB => {
    const value = names.map(key => style.getPropertyValue(key).trim()).find(Boolean);
    if (!ctx || !value) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };
  const bg = read(["--background"], [255, 255, 255]);
  const dark = (bg[0] * .299 + bg[1] * .587 + bg[2] * .114) < 128;
  const c1 = read(["--voice-orb-tint", "--accent"], [90, 90, 90]);
  const c2 = style.getPropertyValue("--voice-orb-tint-2").trim() ? read(["--voice-orb-tint-2"], c1) : shift(c1, 26, dark ? .08 : .14);
  return { c1, c2, c3: mix(c1, [255, 255, 255], dark ? .78 : .72), dark };
}

/** A speech like envelope: syllables inside phrases, with breaths between them. Deterministic, so it needs no audio. */
export function speechEnvelope(seconds: number, seed = 0) {
  const t = seconds + seed * 7.3;
  const syllable = Math.pow(Math.max(0, Math.sin(t * 7.2) * .5 + Math.sin(t * 11.3 + 1.2) * .5), 1.4);
  const phrase = clamp(Math.sin(t * 1.15) * .7 + .55);
  return clamp(syllable * phrase * 1.1);
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** The sphere's radius as a share of half the canvas. */
const BASE = .6;

const VERTEX = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;
const FRAGMENT = `precision highp float;
uniform vec2 uRes;
uniform float uTime, uSwirl, uScale, uWobble, uVoice, uRing, uRingPhase, uShimmer, uShimmerAngle, uHalo, uMute, uBright, uDark;
uniform vec3 uC1, uC2, uC3;
vec3 permute(vec3 x){return mod(((x*34.)+1.)*x,289.);}
float snoise(vec2 v){
  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod(i,289.);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;
  vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);
}
void main(){
  vec2 p=(gl_FragCoord.xy/uRes-.5)*2./${BASE.toFixed(2)};
  float r=length(p), ang=atan(p.y,p.x), t=uTime;
  float edge=uScale*(1.+uWobble*(.55*sin(2.*ang+t*.9)+.3*sin(3.*ang-t*1.3)+.15*sin(5.*ang+t*2.1))
    +uVoice*(.05*sin(4.*ang+t*3.1)+.035*sin(7.*ang-t*2.4)));
  float px=2./(${BASE.toFixed(2)}*uRes.x);
  float inside=1.-smoothstep(edge-px,edge+px,r);
  vec2 q=p/edge; float rr=min(length(q),1.); float z=sqrt(1.-rr*rr);
  float sw=uSwirl*(1.-rr*.55); vec2 f=mat2(cos(sw),-sin(sw),sin(sw),cos(sw))*q;
  f/=(.55+.45*z);
  vec2 w=vec2(snoise(f*.55+vec2(0.,t*.3)),snoise(f*.55+vec2(5.2,-t*.27)));
  float n1=snoise(f*.62+w*.5+vec2(t*.16,1.7));
  float n2=snoise(f*.9-w*.4+vec2(-t*.2,3.1));
  vec3 col=mix(uC1,uC2,smoothstep(-.9,.9,n1));
  col=mix(col,uC3,smoothstep(0.,1.,n2)*.42);
  float light=dot(normalize(vec3(q*.9,z)),normalize(vec3(-.45,.55,.75)));
  col*=.8+.28*light;
  col=mix(col,uC3,pow(1.-z,2.6)*.5);
  col=mix(col,uC3,clamp(uBright,0.,1.)*(.35+.65*z));
  float da=atan(sin(ang-uShimmerAngle),cos(ang-uShimmerAngle));
  float db=atan(sin(ang-uShimmerAngle+3.14159),cos(ang-uShimmerAngle+3.14159));
  float band=(exp(-da*da*1.8)+.5*exp(-db*db*3.))*smoothstep(.1,.95,rr);
  col=mix(col,mix(uC3,vec3(1.),.7),band*uShimmer*.85);
  vec2 h=q-vec2(-.36,.42); col+=vec3(1.)*exp(-dot(h,h)*8.)*.2;
  col=mix(col,vec3(dot(col,vec3(.299,.587,.114))),uMute*.7);
  col=clamp(col,0.,1.);
  float d=max(r-edge,0.);
  float fade=1.-smoothstep(1.2,1.62,r);
  float halo=exp(-d*(uDark>.5?3.2:4.2))*uHalo*fade;
  float ring=0.;
  for(int i=0;i<3;i++){
    float ph=fract(uRingPhase+float(i)/3.);float rad=edge+.06+ph*.5;float wd=.018+ph*.03;
    float k=(r-rad)/wd; ring+=exp(-k*k)*(1.-ph)*(1.-ph)*smoothstep(0.,.12,ph);
  }
  ring*=uRing*fade;
  float oa=clamp(halo+ring*.5,0.,1.)*(1.-inside);
  vec3 glow=uDark>.5?mix(uC1,uC3,.35):uC1;
  vec3 outc=col*inside+glow*oa;
  gl_FragColor=vec4(outc,inside+oa);
}`;

interface Frame { p: Params; time: number; swirl: number; ringPhase: number; shimmerAngle: number; level: number; clock: number }

interface Painter { draw(frame: Frame): void; setPalette(palette: Palette): void; dispose(): void }

function createGlPainter(canvas: HTMLCanvasElement, palette: Palette): Painter | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX), fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  const names = ["uRes", "uTime", "uSwirl", "uScale", "uWobble", "uVoice", "uRing", "uRingPhase", "uShimmer", "uShimmerAngle", "uHalo", "uMute", "uBright", "uDark", "uC1", "uC2", "uC3"] as const;
  const u = Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)])) as Record<(typeof names)[number], WebGLUniformLocation | null>;
  const setPalette = (next: Palette) => {
    gl.uniform3f(u.uC1, next.c1[0] / 255, next.c1[1] / 255, next.c1[2] / 255);
    gl.uniform3f(u.uC2, next.c2[0] / 255, next.c2[1] / 255, next.c2[2] / 255);
    gl.uniform3f(u.uC3, next.c3[0] / 255, next.c3[1] / 255, next.c3[2] / 255);
    gl.uniform1f(u.uDark, next.dark ? 1 : 0);
  };
  setPalette(palette);
  return {
    setPalette,
    draw({ p, time, swirl, ringPhase, shimmerAngle, level, clock }) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      const voice = level * p.gain;
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uSwirl, swirl);
      gl.uniform1f(u.uScale, 1 + p.grow + p.breath * Math.sin(clock * 1.25) + voice * .9);
      gl.uniform1f(u.uWobble, p.wobble);
      gl.uniform1f(u.uVoice, voice * 2.6);
      gl.uniform1f(u.uRing, p.ring * (.35 + level * .9));
      gl.uniform1f(u.uRingPhase, ringPhase);
      gl.uniform1f(u.uShimmer, p.shimmer);
      gl.uniform1f(u.uShimmerAngle, shimmerAngle);
      gl.uniform1f(u.uHalo, p.halo * (.2 + voice * 1.6) + p.shimmer * .08);
      gl.uniform1f(u.uMute, p.mute);
      gl.uniform1f(u.uBright, voice * 2.2);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}

/** Without WebGL: the same sphere as layered canvas gradients, lit from the upper left, with the halo and ripples. */
function create2dPainter(canvas: HTMLCanvasElement, palette: Palette): Painter | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let colors = palette;
  return {
    setPalette(next) { colors = next; },
    draw({ p, time, ringPhase, level, clock }) {
      const size = canvas.width, c = size / 2, voice = level * p.gain;
      const radius = c * BASE * (1 + p.grow + p.breath * Math.sin(clock * 1.25) + voice * .9);
      ctx.clearRect(0, 0, size, size);
      const halo = ctx.createRadialGradient(c, c, radius, c, c, c);
      halo.addColorStop(0, rgba(colors.c1, p.halo * (.2 + voice * 2.2) * .6));
      halo.addColorStop(1, rgba(colors.c1, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 3 && p.ring > .01; i++) {
        const ph = (ringPhase + i / 3) % 1;
        ctx.beginPath();
        ctx.arc(c, c, radius * (1.06 + ph * .5), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colors.c1, p.ring * (.35 + level * .9) * (1 - ph) * (1 - ph) * .4);
        ctx.lineWidth = size * .008;
        ctx.stroke();
      }
      const body = ctx.createRadialGradient(c - radius * .36, c - radius * .42, radius * .05, c, c, radius);
      body.addColorStop(0, rgba(colors.c3, 1));
      body.addColorStop(.45, rgba(mix(colors.c2, colors.c3, voice * 2), 1));
      body.addColorStop(1, rgba(colors.c1, 1));
      ctx.beginPath();
      ctx.arc(c + Math.sin(time) * radius * p.wobble, c, radius, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
    },
    dispose() {},
  };
}

export function VoiceOrb({ state, inputLevel, outputLevel, muted = false, size = 208, label, className }: VoiceOrbProps) {
  const reduced = useReducedFlag();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, muted, inputLevel, outputLevel });
  useLayoutEffect(() => { live.current = { state, muted, inputLevel, outputLevel }; });
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(size * dpr);
    let colors = readPalette(canvas);
    const painter = createGlPainter(canvas, colors) ?? create2dPainter(canvas, colors);
    if (!painter) return;

    const targetOf = () => live.current.state === "listening" && live.current.muted ? MUTED : TARGETS[live.current.state];
    const cur: Params = { ...targetOf() }, vel = Object.fromEntries(KEYS.map(key => [key, 0])) as Params;
    const frame: Frame = { p: cur, time: 0, swirl: 0, ringPhase: 0, shimmerAngle: 0, level: 0, clock: 0 };
    let last = performance.now(), raf = 0, visible = true;

    const still = () => {
      const p = targetOf();
      painter.draw({ p, time: 1.2, swirl: .6, ringPhase: .35, shimmerAngle: 2.2, level: live.current.state === "speaking" ? .4 : live.current.state === "listening" && !live.current.muted ? .3 : 0, clock: 0 });
    };
    const tick = (now: number) => {
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      frame.clock += dt;
      const target = targetOf();
      // Each parameter rides a gently damped spring, so a new state blends from wherever the orb is.
      for (const key of KEYS) {
        vel[key] += (40 * (target[key] - cur[key]) - 12.6 * vel[key]) * dt;
        cur[key] += vel[key] * dt;
      }
      const { state: mode, muted: silent, inputLevel: input, outputLevel: output } = live.current;
      const goal = mode === "listening" && !silent ? input?.get() ?? speechEnvelope(frame.clock, 3) * .7
        : mode === "speaking" ? output?.get() ?? speechEnvelope(frame.clock) : 0;
      // Fast attack, slow release, the way a level meter reads.
      frame.level += (clamp(goal) - frame.level) * (1 - Math.exp(-dt * (goal > frame.level ? 18 : 5)));
      frame.time += dt * (cur.flow + frame.level * cur.gain * 3);
      frame.swirl += dt * cur.swirl;
      frame.ringPhase = (frame.ringPhase + dt * (.42 + frame.level * .5)) % 1;
      frame.shimmerAngle -= dt * 2.3;
      painter.draw(frame);
      raf = requestAnimationFrame(tick);
    };
    const start = () => { if (reduced || raf || !visible || document.hidden) return; last = performance.now(); raf = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    redraw.current = () => { if (reduced) still(); };

    const refresh = () => { colors = readPalette(canvas); painter.setPalette(colors); if (reduced) still(); };
    const themeObserver = new MutationObserver(refresh);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-accent"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", refresh);
    const viewObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) start(); else stop(); });
    viewObserver.observe(canvas);
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener("visibilitychange", onVisibility);

    if (reduced) still(); else start();
    return () => {
      stop();
      themeObserver.disconnect(); viewObserver.disconnect();
      scheme.removeEventListener("change", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      painter.dispose();
    };
  }, [size, reduced]);

  // Reduced motion draws one still frame per state.
  useEffect(() => { redraw.current(); }, [state, muted]);

  return <canvas ref={canvasRef} key={reduced ? "still" : "live"} className={[styles.orb, className].filter(Boolean).join(" ")} style={{ width: size, height: size }}
    data-state={state} data-reduced={reduced ? "" : undefined} role="img" aria-label={label ?? (state === "listening" && muted ? "Muted" : LABELS[state])} />;
}

export type MicSource = "off" | "requesting" | "microphone" | "simulated";

/**
 * Reads the microphone level while `enabled`, as a motion value from 0 to 1. Asks for permission the first time; when the
 * microphone is denied or unavailable, it falls back to a simulated voice so the orb still reacts. Nothing is recorded:
 * the audio only feeds an analyser, and the tracks stop as soon as `enabled` turns false.
 */
export function useMicLevel(enabled: boolean): { level: MotionValue<number>; source: MicSource } {
  const level = useMotionValue(0);
  const [source, setSource] = useState<MicSource>("off");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false, frame = 0;
    let stream: MediaStream | null = null, audio: AudioContext | null = null;
    const simulate = () => {
      setSource("simulated");
      const begin = performance.now();
      const loop = (now: number) => { level.set(speechEnvelope((now - begin) / 1000, 3) * .8); frame = requestAnimationFrame(loop); };
      frame = requestAnimationFrame(loop);
    };
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") { simulate(); return; }
      setSource("requesting");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        setSource("microphone");
        const loop = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const db = 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-6);
          level.set(clamp((db + 58) / 38));
          frame = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        if (!cancelled) simulate();
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach(track => track.stop());
      void audio?.close();
      level.set(0);
    };
  }, [enabled, level]);
  return { level, source: enabled ? source : "off" };
}

/**
 * One line of live transcript. Words settle in from a soft blur as they stream, the text holds two lines and lifts older lines
 * away, and a new turn crossfades in. Only the finished turn is announced to screen readers.
 */
export interface VoiceTranscriptProps {
  text: string;
  /** Changes when a new turn begins, so the old one crossfades out. */
  turn?: string | number;
  /** Who is talking. The assistant reads in the foreground color, the person in secondary. */
  speaker?: "user" | "assistant" | "system";
  /** Set when the turn is complete, to announce it. */
  complete?: boolean;
  className?: string;
}

export function VoiceTranscript({ text, turn = 0, speaker = "assistant", complete = false, className }: VoiceTranscriptProps) {
  const reduced = useReducedFlag();
  const words = text ? text.split(/\s+/) : [];
  const { spring, duration, ease, blur } = motionTokens;
  return <div className={[styles.transcript, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.p key={turn} className={styles.line} data-speaker={speaker} aria-hidden="true" layout={reduced ? false : "position"}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10, filter: `blur(${blur.soft}px)`, transition: { duration: duration.exit, ease: [...ease.standard] } }}
        transition={reduced ? { duration: duration.instant } : spring.smooth}>
        {words.map((word, index) => <Fragment key={index}>
          <motion.span className={styles.word} initial={reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${blur.soft}px)`, y: 3 }}
            animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} transition={{ duration: reduced ? duration.instant : .34, ease: [...ease.enter] }}>{word}</motion.span>
          {index < words.length - 1 ? " " : null}
        </Fragment>)}
      </motion.p>
    </AnimatePresence>
    <p className={styles.srOnly} aria-live="polite">{complete ? text : ""}</p>
  </div>;
}

/**
 * The call controls as one surface. At rest it is a single start button; once a session is live the surface springs wider and
 * mute, a running clock, and end morph in. Focus follows into the new controls and back to start when the call ends.
 */
export interface VoiceControlsProps {
  active: boolean;
  muted?: boolean;
  /** Seconds since the session began, shown with tabular numerals. */
  elapsed?: number;
  onStart?: () => void;
  onMuteChange?: (muted: boolean) => void;
  onEnd?: () => void;
  startLabel?: ReactNode;
  className?: string;
}

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function VoiceControls({ active, muted = false, elapsed = 0, onStart, onMuteChange, onEnd, startLabel = "Start voice chat", className }: VoiceControlsProps) {
  const reduced = useReducedFlag();
  const { spring, duration, blur } = motionTokens;
  const contentRef = useRef<HTMLDivElement>(null);
  const muteRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const [width, setWidth] = useState<number | "auto">("auto");

  // The surface springs to the width of whichever content is present; the leaving content pops out of flow at once.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    /* The used width, unrounded and unaffected by the enter scale, so the pill never clips its content by a fraction of a pixel. */
    const measure = () => setWidth(parseFloat(getComputedStyle(node).width) || node.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (active ? muteRef.current : startRef.current)?.focus();
  }, [active]);

  const t: Transition = reduced ? { duration: 0 } : spring.morph;
  const enter = reduced ? { opacity: 0 } : { opacity: 0, scale: .92, filter: `blur(${blur.soft}px)` };
  const leave = { ...enter, transition: { duration: duration.instant } };
  const fade: Transition = reduced ? { duration: duration.instant } : { ...spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } };
  return <motion.div className={[styles.controls, className].filter(Boolean).join(" ")} data-active={active ? "" : undefined}
    initial={false} animate={{ width }} transition={t}>
    <AnimatePresence mode="popLayout" initial={false}>
      {active ? <motion.div key="live" ref={contentRef} className={styles.live} initial={enter} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={leave} transition={fade}>
        <button ref={muteRef} type="button" className={styles.round} aria-pressed={muted} aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          onClick={() => onMuteChange?.(!muted)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={muted ? "off" : "on"} className={styles.glyph} initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: .6, transition: { duration: duration.instant } }} transition={reduced ? { duration: duration.instant } : spring.snappy}>
              {muted ? <MicOff size={18} strokeWidth={1.75} aria-hidden="true" /> : <Mic size={18} strokeWidth={1.75} aria-hidden="true" />}
            </motion.span>
          </AnimatePresence>
        </button>
        <span className={styles.clock} role="timer" aria-label={`${Math.floor(elapsed / 60)} minutes ${Math.floor(elapsed % 60)} seconds`}>{clockText(elapsed)}</span>
        <button type="button" className={styles.end} aria-label="End voice chat" onClick={() => { moveFocus.current = true; onEnd?.(); }}>
          <PhoneOff size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </motion.div> : <motion.div key="start" ref={contentRef} className={styles.idle} initial={enter} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={leave} transition={fade}>
        <button ref={startRef} type="button" className={styles.start} onClick={() => { moveFocus.current = true; onStart?.(); }}>
          <Mic size={18} strokeWidth={1.75} aria-hidden="true" />{startLabel}
        </button>
      </motion.div>}
    </AnimatePresence>
  </motion.div>;
}

export default VoiceOrb;
