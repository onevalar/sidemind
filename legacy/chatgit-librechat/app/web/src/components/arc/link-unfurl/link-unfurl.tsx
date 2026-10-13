"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ClipboardEvent, CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowUp, Check, ChevronUp, Play, X } from "lucide-react";
import styles from "./link-unfurl.module.css";

/* ---------------------------------------------------------------------------------------------- */
/* Types */

export interface LinkUnfurlPreview {
  /** The address the preview belongs to. */
  url: string;
  /** Site or product name shown beside the favicon, such as “Figma”. */
  site: string;
  title: string;
  description?: string;
  /** Preview image URL, shown at 1.91 : 1 like an Open Graph image. */
  image?: string;
  imageAlt?: string;
  /** Favicon URL. A monogram of the site is drawn without one. */
  favicon?: string;
  /** Marks the preview as a video and shows this length over the image, such as “12:48”. */
  duration?: string;
}

export interface LinkUnfurlMessage {
  /** The message text with every link written out as its address. */
  text: string;
  /** Previews that were resolved for the links in the message. */
  links: LinkUnfurlPreview[];
}

export interface LinkUnfurlProps {
  /** Accessible name of the message field. */
  label?: string;
  placeholder?: string;
  /** Starting text of the message. */
  defaultValue?: string;
  /** Sample links offered as buttons under the field. Their previews are used by the built in resolver. Pass an empty array to hide them. */
  samples?: LinkUnfurlPreview[];
  /** Fetches a preview for a pasted address. Return null when there is none. Without it, samples resolve by address and other links get a plain preview after a short simulated fetch. */
  resolve?: (url: string, signal: AbortSignal) => Promise<LinkUnfurlPreview | null>;
  /** Opens a preview as soon as it resolves. */
  autoExpand?: boolean;
  /** Pastes the first sample the first time the composer scrolls into view, unless someone has already interacted. */
  autoPlay?: boolean;
  /** Multiplier for the morph and the simulated fetch. */
  speed?: number;
  /** Opens and closes previews without the morph and turns autoplay off. */
  paused?: boolean;
  /** Color of an unfurled link and its connection to the card. Defaults to the accent. */
  accent?: string;
  sendLabel?: string;
  /** Called with the message on Enter or the send button. Return a promise to hold the composer until it settles; a rejection shows its message. */
  onSend?: (message: LinkUnfurlMessage) => void | Promise<unknown>;
  className?: string;
  style?: CSSProperties;
}

type LinkStatus = "loading" | "ready" | "failed";
interface Link {
  id: string;
  url: string;
  status: LinkStatus;
  preview?: LinkUnfurlPreview;
  expanded: boolean;
}
interface Morph {
  p: number;
  v: number;
  target: 0 | 1;
  wrap: HTMLDivElement | null;
  plate: HTMLDivElement | null;
  card: HTMLElement | null;
  body: HTMLDivElement | null;
  media: HTMLImageElement | null;
  dragging: boolean;
  settle: (() => void) | null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Sample content. Brand marks are sample content, not endorsements. */

export const linkUnfurlSamples: LinkUnfurlPreview[] = [
  {
    url: "https://www.airbnb.com/rooms/48213907",
    site: "Airbnb",
    title: "Rooftop loft in Alfama with river views",
    description: "Entire loft for 8 guests. 4 bedrooms, a shared terrace, and a 6 minute walk to the tram.",
    image: "/media/photos/lisbon-rooftops.jpg",
    imageAlt: "Terracotta rooftops of Lisbon stepping down to the river",
    favicon: "/block-logos/airbnb-color.svg",
  },
  {
    url: "https://www.figma.com/design/q8Rk2/Offsite-itinerary",
    site: "Figma",
    title: "Offsite itinerary, day by day",
    description: "Design file with 14 frames. Edited by Sofia Ramirez 2 hours ago.",
    image: "/media/photos/lisbon-tram.jpg",
    imageAlt: "A yellow tram climbing a narrow Lisbon street",
    favicon: "/block-logos/figma-color.svg",
  },
  {
    url: "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n",
    site: "Spotify",
    title: "Lisbon evenings",
    description: "Playlist by Daniel Kim. 42 songs, 2 hr 51 min.",
    image: "/media/photos/sea-at-dusk.jpg",
    imageAlt: "The sea at dusk under a soft pink sky",
    favicon: "/block-logos/spotify-color.svg",
    duration: "2:51:06",
  },
];

/* ---------------------------------------------------------------------------------------------- */
/* Helpers */

const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/[^\s]*)?$/i;
const GAP = 10;
const RADIUS = 18;
/* Motion tokens (--ease-enter, --ease-standard, --ease-exit) for the WAAPI calls below. */
const EASE_ENTER = "cubic-bezier(.16, 1, .3, 1)";
const EASE_STANDARD = "cubic-bezier(.22, 1, .36, 1)";
const EASE_EXIT = "cubic-bezier(.7, 0, .84, 0)";
const GLOBE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M1.9 8h12.2M8 1.7c1.8 1.9 2.6 3.9 2.6 6.3S9.8 12.4 8 14.3M8 1.7C6.2 3.6 5.4 5.6 5.4 8s.8 4.4 2.6 6.3"/></svg>`;
const LINK_OFF = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M6.6 4.2 7.8 3a3 3 0 0 1 4.2 4.2l-1.2 1.2M9.4 11.8 8.2 13A3 3 0 0 1 4 8.8l1.2-1.2M2.5 2.5l11 11"/></svg>`;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const normalize = (raw: string) => (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};
const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
const sameUrl = (a: string, b: string) => shortUrl(a).toLowerCase() === shortUrl(b).toLowerCase();
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  const t = window.setTimeout(done, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(t); fail(new Error("aborted")); }, { once: true });
});

/** A plain preview built from the address alone, for links the resolver does not know. */
function plainPreview(url: string): LinkUnfurlPreview {
  const host = hostOf(url);
  let title = host;
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) {
      const words = decodeURIComponent(last).replace(/\.[a-z]+$/i, "").replace(/[-_+]+/g, " ").trim();
      if (words && /[a-z]/i.test(words)) title = words.charAt(0).toUpperCase() + words.slice(1);
    }
  } catch { /* keep the host */ }
  return { url, site: host, title, description: shortUrl(url) };
}

/* ---------------------------------------------------------------------------------------------- */
/* Component */

export function LinkUnfurl({
  label = "Message #lisbon-offsite",
  placeholder = "Message #lisbon-offsite",
  defaultValue = "Found a place for the offsite, take a look",
  samples = linkUnfurlSamples,
  resolve,
  autoExpand = true,
  autoPlay = true,
  speed = 1,
  paused = false,
  accent,
  sendLabel = "Send message",
  onSend,
  className,
  style,
}: LinkUnfurlProps) {
  const reduce = useReducedMotion() ?? false;
  const uid = useId();
  const hintId = `${uid}-hint`;
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [announce, setAnnounce] = useState("");
  const [empty, setEmpty] = useState(!defaultValue);
  const [sending, setSending] = useState<"idle" | "pending" | "sent">("idle");
  const [error, setError] = useState("");
  const [initialHtml] = useState(() => ({ __html: defaultValue.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + (defaultValue ? " " : "") }));

  const linksRef = useRef(links);
  useLayoutEffect(() => { linksRef.current = links; }, [links]);
  const morphs = useRef(new Map<string, Morph>());
  const aborts = useRef(new Map<string, AbortController>());
  const seq = useRef(0);
  const touched = useRef(false);
  const mounted = useRef(true);
  const visible = useRef(true);
  const lastRange = useRef<Range | null>(null);
  const opts = useRef({ reduce, paused, speed, autoExpand, resolve, samples, onSend });
  useLayoutEffect(() => { opts.current = { reduce, paused, speed, autoExpand, resolve, samples, onSend }; });
  const tickRef = useRef<(now: number) => void>(() => {});
  const raf = useRef(0);
  const lastT = useRef(0);

  const animating = () => visible.current && !opts.current.reduce && !opts.current.paused;
  const chipOf = (id: string) => editorRef.current?.querySelector<HTMLElement>(`[data-link-id="${id}"]`) ?? null;
  const say = (msg: string) => setAnnounce(prev => (prev === msg ? `${msg} ` : msg));

  /* ---- Morph engine: one rAF loop writes transforms, clip paths, and opacity directly. ---- */

  const render = useCallback(() => {
    const editor = editorRef.current;
    const jobs: { m: Morph; W: number; H: number; sx: number; sy: number; sw: number; sh: number; tx: number; ty: number; chip: HTMLElement | null }[] = [];
    // Read everything first so the frame does one layout pass.
    morphs.current.forEach((m, id) => {
      if (!m.wrap || !m.plate || !m.card) return;
      const W = m.card.offsetWidth, H = m.card.offsetHeight;
      const wr = m.wrap.getBoundingClientRect();
      const wrapEl = editor?.querySelector<HTMLElement>(`[data-link-id="${id}"]`) ?? null;
      const chip = wrapEl?.firstElementChild as HTMLElement | null;
      const favCard = m.card.querySelector<HTMLElement>("[data-fav]");
      let sx = 0, sy = 0, sw = Math.min(W, 132), sh = 26, tx = 0, ty = 0;
      if (chip && chip.isConnected && favCard) {
        const cr = chip.getBoundingClientRect();
        const fr = (chip.firstElementChild as HTMLElement).getBoundingClientRect();
        sx = favCard.offsetLeft - (fr.left - cr.left);
        sy = favCard.offsetTop - (fr.top - cr.top);
        sw = Math.min(cr.width, W - Math.max(0, sx));
        sh = Math.min(cr.height, H);
        tx = cr.left - wr.left - sx;
        ty = cr.top - wr.top - sy;
      }
      jobs.push({ m, W, H, sx, sy, sw, sh, tx, ty, chip: wrapEl });
    });
    for (const j of jobs) {
      const { m, W, H } = j;
      const p = clamp01(m.p);
      // Width leads and height follows, so the link reads as unrolling into the card.
      const px = 1 - Math.pow(1 - p, 1.6);
      const py = Math.pow(p, 1.35);
      const rx = j.sx * (1 - px), rw = j.sw + (W - j.sw) * px;
      const ry = j.sy * (1 - py), rh = j.sh + (H - j.sh) * py;
      const tx = j.tx * (1 - px), ty = j.ty * (1 - py);
      const r = j.sh / 2 + (RADIUS - j.sh / 2) * p;
      const o = clamp01(p / 0.1);
      const open = p > 0.0005;
      m.wrap!.style.height = `${((H + GAP) * py).toFixed(2)}px`;
      const plate = m.plate!.style;
      plate.transform = `translate3d(${(rx + tx).toFixed(2)}px, ${(ry + ty).toFixed(2)}px, 0)`;
      plate.width = `${rw.toFixed(2)}px`;
      plate.height = `${rh.toFixed(2)}px`;
      plate.borderRadius = `${r.toFixed(2)}px`;
      plate.opacity = String(o);
      plate.setProperty("--lift", (p > 0 && p < 1 ? Math.sin(Math.PI * p) : 0).toFixed(3));
      const card = m.card!;
      card.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
      card.style.clipPath = `inset(${ry.toFixed(2)}px ${(W - rx - rw).toFixed(2)}px ${(H - ry - rh).toFixed(2)}px ${rx.toFixed(2)}px round ${r.toFixed(2)}px)`;
      card.style.opacity = String(o);
      card.style.visibility = open ? "visible" : "hidden";
      if (card.inert === open) card.inert = !open;
      if (m.body) m.body.style.opacity = clamp01((py - 0.15) / 0.55).toFixed(3);
      if (m.media) m.media.style.transform = `scale(${(1.08 - 0.08 * py).toFixed(4)})`;
      if (j.chip) j.chip.dataset.expanded = m.target === 1 ? "true" : "false";
    }
  }, []);

  const tick = useCallback((now: number) => {
    raf.current = 0;
    // The first frame after a wake takes one nominal step, so a morph never starts with a double jump.
    const dt = lastT.current ? Math.min(0.034, Math.max(0.001, (now - lastT.current) / 1000)) : 1 / 60;
    lastT.current = now;
    const s = opts.current.speed || 1;
    let active = false;
    const done: (() => void)[] = [];
    morphs.current.forEach(m => {
      if (!m.card) return;
      if (m.dragging) { active = true; return; }
      if (m.p === m.target && m.v === 0) {
        if (m.settle) { done.push(m.settle); m.settle = null; }
        return;
      }
      // Critically damped: lands without overshoot. Closing is quicker than opening.
      const w = (m.target === 1 ? 9.5 : 13) * s;
      const a = -w * w * (m.p - m.target) - 2 * w * m.v;
      m.v += a * dt;
      m.p += m.v * dt;
      if (Math.abs(m.p - m.target) < 0.0003 && Math.abs(m.v) < 0.01) { m.p = m.target; m.v = 0; }
      active = true;
    });
    render();
    done.forEach(f => f());
    if (active) raf.current = requestAnimationFrame(t => tickRef.current(t));
  }, [render]);
  useLayoutEffect(() => { tickRef.current = tick; }, [tick]);

  const kick = useCallback(() => {
    if (!animating()) {
      const done: (() => void)[] = [];
      morphs.current.forEach(m => {
        if (m.dragging || !m.card) return;
        m.p = m.target; m.v = 0;
        if (m.settle) { done.push(m.settle); m.settle = null; }
      });
      render();
      done.forEach(f => f());
      return;
    }
    if (!raf.current) { lastT.current = 0; raf.current = requestAnimationFrame(tick); }
  }, [render, tick]);

  const morphOf = (id: string) => {
    let m = morphs.current.get(id);
    if (!m) {
      m = { p: 0, v: 0, target: 0, wrap: null, plate: null, card: null, body: null, media: null, dragging: false, settle: null };
      morphs.current.set(id, m);
    }
    return m;
  };

  const bind = (id: string, key: "wrap" | "plate" | "card" | "body" | "media") => (el: HTMLElement | null) => {
    if (!el) return;
    const m = morphOf(id);
    if (m[key] === el) return;
    (m as unknown as Record<string, HTMLElement | null>)[key] = el;
    if (m.wrap && m.plate && m.card) kick();
  };

  /* ---- Links ---- */

  const setExpanded = useCallback((id: string, open: boolean, speak = true) => {
    const link = linksRef.current.find(l => l.id === id);
    if (!link || link.status !== "ready") return;
    setLinks(ls => ls.map(l => (l.id === id ? { ...l, expanded: open } : l)));
    const m = morphOf(id);
    m.target = open ? 1 : 0;
    m.settle = null;
    const chip = chipOf(id);
    if (chip) chip.dataset.expanded = open ? "true" : "false";
    if (speak && link.preview) say(open ? `Preview shown. ${link.preview.site}, ${link.preview.title}.` : `Preview collapsed into the link. ${link.preview.title}.`);
    kick();
  }, [kick]);

  const dropLink = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    morphs.current.delete(id);
    setLinks(ls => ls.filter(l => l.id !== id));
  }, []);

  const markReady = (id: string, preview: LinkUnfurlPreview) => {
    const wrap = chipOf(id);
    if (!wrap) return;
    wrap.dataset.status = "ready";
    const chip = wrap.firstElementChild as HTMLElement;
    const fav = chip.firstElementChild as HTMLElement;
    const text = chip.lastElementChild as HTMLElement;
    const w0 = chip.getBoundingClientRect().width;
    fav.textContent = "";
    if (preview.favicon) {
      const img = document.createElement("img");
      img.src = preview.favicon; img.alt = ""; img.width = 16; img.height = 16; img.draggable = false;
      fav.appendChild(img);
    } else {
      fav.textContent = preview.site.charAt(0).toUpperCase();
      fav.dataset.mono = "true";
    }
    text.textContent = preview.title;
    wrap.setAttribute("aria-label", `${preview.title}, ${preview.site} link`);
    if (animating()) {
      const w1 = chip.getBoundingClientRect().width;
      const d = 340 / (opts.current.speed || 1);
      chip.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: d, easing: EASE_ENTER });
      text.animate([{ opacity: 0, transform: "translateY(5px)", filter: "blur(2px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: d, easing: EASE_ENTER });
      fav.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: d * 0.8, easing: EASE_ENTER });
    }
  };

  const markFailed = (id: string) => {
    const wrap = chipOf(id);
    if (!wrap) return;
    wrap.dataset.status = "failed";
    ((wrap.firstElementChild as HTMLElement).firstElementChild as HTMLElement).innerHTML = LINK_OFF;
    wrap.setAttribute("aria-label", `${shortUrl(wrap.dataset.url ?? "")}, no preview. Click to try again.`);
  };

  const fetchPreview = useCallback((id: string, url: string) => {
    aborts.current.get(id)?.abort();
    const ctrl = new AbortController();
    aborts.current.set(id, ctrl);
    const { resolve: custom, samples: known, speed: s } = opts.current;
    const run = custom
      ? custom(url, ctrl.signal)
      : (async () => {
        await wait(1150 / (s || 1), ctrl.signal);
        return known.find(k => sameUrl(k.url, url)) ?? plainPreview(url);
      })();
    run
      .then(async preview => {
        // Warm the image so the card never unfurls onto an empty frame.
        if (preview?.image) {
          const img = new Image();
          img.src = preview.image;
          await Promise.race([img.decode().catch(() => undefined), new Promise(r => window.setTimeout(r, 1500))]);
        }
        return preview;
      })
      .then(preview => {
        if (!mounted.current || ctrl.signal.aborted || !linksRef.current.some(l => l.id === id)) return;
        aborts.current.delete(id);
        if (!preview) {
          markFailed(id);
          setLinks(ls => ls.map(l => (l.id === id ? { ...l, status: "failed" } : l)));
          say(`No preview for ${hostOf(url)}. The link stays in the message.`);
          return;
        }
        const full = { ...preview, url: preview.url || url };
        markReady(id, full);
        const open = opts.current.autoExpand;
        setLinks(ls => ls.map(l => (l.id === id ? { ...l, status: "ready", preview: full, expanded: open } : l)));
        const m = morphOf(id);
        m.target = open ? 1 : 0;
        const chip = chipOf(id);
        if (chip) chip.dataset.expanded = open ? "true" : "false";
        say(open ? `Preview shown. ${full.site}, ${full.title}.` : `Preview ready for ${full.title}.`);
        kick();
      })
      .catch(() => {
        if (!mounted.current || ctrl.signal.aborted || !linksRef.current.some(l => l.id === id)) return;
        markFailed(id);
        setLinks(ls => ls.map(l => (l.id === id ? { ...l, status: "failed" } : l)));
        say(`Could not load a preview for ${hostOf(url)}. Click the link to try again.`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kick]);

  const makeChip = (id: string, url: string) => {
    const wrap = document.createElement("span");
    wrap.className = styles.chipWrap;
    wrap.contentEditable = "false";
    wrap.dataset.linkId = id;
    wrap.dataset.url = url;
    wrap.dataset.status = "loading";
    wrap.setAttribute("aria-label", `${shortUrl(url)}, loading preview`);
    const chip = document.createElement("span");
    chip.className = styles.chip;
    const fav = document.createElement("span");
    fav.className = styles.chipFav;
    fav.innerHTML = GLOBE;
    const text = document.createElement("span");
    text.className = styles.chipLabel;
    text.textContent = shortUrl(url);
    chip.appendChild(fav);
    chip.appendChild(text);
    wrap.appendChild(chip);
    return wrap;
  };

  const syncEmpty = () => {
    const editor = editorRef.current;
    if (!editor) return;
    setEmpty(!editor.textContent?.trim() && !editor.querySelector("[data-link-id]"));
  };

  /** Inserts a link chip at the caret (or the end) and starts fetching its preview. */
  const insertLink = useCallback((raw: string, where: "caret" | "end" = "caret") => {
    const editor = editorRef.current;
    if (!editor) return;
    const url = normalize(raw.trim());
    const id = `lu${++seq.current}`;
    let range: Range;
    const sel = window.getSelection();
    const live = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (where === "caret" && live && editor.contains(live.commonAncestorContainer)) range = live;
    else if (where === "caret" && lastRange.current && editor.contains(lastRange.current.commonAncestorContainer)) range = lastRange.current.cloneRange();
    else { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
    range.deleteContents();
    // Keep a space on both sides so the chip reads as a word.
    let before = "";
    const sc = range.startContainer, so = range.startOffset;
    if (sc.nodeType === Node.TEXT_NODE) { if (so > 0 && !/\s/.test((sc as Text).data.charAt(so - 1))) before = " "; }
    else if (so > 0) {
      const prev = sc.childNodes[so - 1];
      if (prev && (prev.nodeType !== Node.TEXT_NODE || !/\s$/.test((prev as Text).data))) before = " ";
    }
    const after = document.createTextNode(" ");
    const chip = makeChip(id, url);
    range.insertNode(after);
    range.insertNode(chip);
    if (before) range.insertNode(document.createTextNode(before));
    const caret = document.createRange();
    caret.setStart(after, 1);
    caret.collapse(true);
    lastRange.current = caret.cloneRange();
    if (document.activeElement === editor && sel) { sel.removeAllRanges(); sel.addRange(caret); }
    setLinks(ls => [...ls, { id, url, status: "loading", expanded: false }]);
    setEmpty(false);
    say(`Link added. Loading a preview for ${hostOf(url)}.`);
    fetchPreview(id, url);
  }, [fetchPreview]);

  /** Collapses the preview into its chip, then lets the chip go. */
  const removeLink = useCallback((id: string) => {
    const link = linksRef.current.find(l => l.id === id);
    const finish = () => {
      const wrap = chipOf(id);
      const after = wrap?.nextSibling;
      const drop = () => {
        if (after && after.nodeType === Node.TEXT_NODE && (after as Text).data.startsWith(" ")) (after as Text).deleteData(0, 1);
        wrap?.remove();
        dropLink(id);
        syncEmpty();
      };
      if (wrap && animating()) {
        const a = wrap.animate([{ opacity: 1, transform: "none", filter: "blur(0)" }, { opacity: 0, transform: "scale(.9)", filter: "blur(2px)" }], { duration: 180, easing: EASE_EXIT });
        a.onfinish = drop;
      } else drop();
    };
    const m = morphs.current.get(id);
    if (m && m.card && m.p > 0) {
      m.target = 0; m.settle = finish;
      setLinks(ls => ls.map(l => (l.id === id ? { ...l, expanded: false } : l)));
      kick();
    } else finish();
    say(`Link removed${link?.preview ? `. ${link.preview.title}` : ""}.`);
    editorRef.current?.focus({ preventScroll: true });
  }, [dropLink, kick]);

  const toggle = useCallback((id: string) => {
    const link = linksRef.current.find(l => l.id === id);
    if (!link) return;
    if (link.status === "failed") {
      const wrap = chipOf(id);
      if (wrap) {
        wrap.dataset.status = "loading";
        ((wrap.firstElementChild as HTMLElement).firstElementChild as HTMLElement).innerHTML = GLOBE;
      }
      setLinks(ls => ls.map(l => (l.id === id ? { ...l, status: "loading" } : l)));
      say(`Trying again for ${hostOf(link.url)}.`);
      fetchPreview(id, link.url);
      return;
    }
    if (link.status === "loading") { say(`Still loading the preview for ${hostOf(link.url)}.`); return; }
    setExpanded(id, !link.expanded);
  }, [fetchPreview, setExpanded]);

  /* ---- Editor events ---- */

  const saveRange = () => {
    const editor = editorRef.current, sel = window.getSelection();
    if (editor && sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) lastRange.current = sel.getRangeAt(0).cloneRange();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    touched.current = true;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    if (URL_RE.test(text.trim())) insertLink(text.trim());
    else document.execCommand("insertText", false, text);
  };

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    touched.current = true;
    const editor = editorRef.current;
    if (!editor) return;
    // A chip deleted with the keyboard takes its card with it.
    for (const l of linksRef.current) {
      if (!chipOf(l.id)) {
        const m = morphs.current.get(l.id);
        if (m && m.card && m.p > 0) { m.target = 0; m.settle = () => dropLink(l.id); kick(); }
        else dropLink(l.id);
        say("Link removed.");
      }
    }
    // A typed address becomes a link when it is followed by a space.
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === "insertText" && native.data === " ") {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      if (node && node.nodeType === Node.TEXT_NODE && sel) {
        const t = node as Text, offset = sel.anchorOffset;
        const m = t.data.slice(0, offset).match(/(?:^|\s)(https?:\/\/[^\s]+|www\.[^\s]+)\s$/i);
        if (m && URL_RE.test(m[1])) {
          const start = offset - 1 - m[1].length;
          const r = document.createRange();
          r.setStart(t, start); r.setEnd(t, start + m[1].length);
          r.collapse(true);
          t.deleteData(start, m[1].length + 1);
          sel.removeAllRanges(); sel.addRange(r);
          insertLink(m[1]);
        }
      }
    }
    saveRange();
    syncEmpty();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    touched.current = true;
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.altKey) {
      e.preventDefault();
      const editor = editorRef.current, sel = window.getSelection();
      const chips = Array.from(editor?.querySelectorAll<HTMLElement>("[data-link-id]") ?? []);
      if (!chips.length) { say("There is no link in the message."); return; }
      let pick = chips[chips.length - 1];
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        const before = chips.filter(c => r.comparePoint(c, 0) <= 0);
        pick = before.length ? before[before.length - 1] : chips[0];
      }
      toggle(pick.dataset.linkId!);
      return;
    }
    e.preventDefault();
    if (e.shiftKey) { document.execCommand("insertLineBreak"); return; }
    void send();
  };

  const onEditorClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = (e.target as HTMLElement).closest<HTMLElement>("[data-link-id]");
    if (!wrap) return;
    touched.current = true;
    toggle(wrap.dataset.linkId!);
  };

  /* ---- Send ---- */

  const serialize = () => {
    let out = "";
    const walk = (n: Node) => n.childNodes.forEach(c => {
      if (c.nodeType === Node.TEXT_NODE) out += (c as Text).data;
      else if (c instanceof HTMLElement) {
        if (c.dataset.url) out += c.dataset.url;
        else if (c.tagName === "BR") out += "\n";
        else { if (c.tagName === "DIV" && out && !out.endsWith("\n")) out += "\n"; walk(c); }
      }
    });
    if (editorRef.current) walk(editorRef.current);
    return out.replace(/ /g, " ").trim();
  };

  const send = async () => {
    const text = serialize();
    if (!text || sending === "pending") { if (!text) say("Write a message or paste a link first."); return; }
    touched.current = true;
    setError("");
    const message: LinkUnfurlMessage = { text, links: linksRef.current.filter(l => l.preview).map(l => l.preview!) };
    setSending("pending");
    try {
      await Promise.resolve(opts.current.onSend?.(message));
    } catch (err) {
      if (!mounted.current) return;
      setSending("idle");
      setError(err instanceof Error && err.message ? err.message : "The message could not be sent. Try again.");
      return;
    }
    if (!mounted.current) return;
    const clear = () => {
      aborts.current.forEach(a => a.abort());
      aborts.current.clear();
      morphs.current.clear();
      if (editorRef.current) editorRef.current.textContent = "";
      lastRange.current = null;
      setLinks([]);
      setEmpty(true);
    };
    const content = contentRef.current;
    if (content && animating()) {
      // Hold the faded frame until the cards are gone, then let the field close its gap instead of snapping shut.
      const out = content.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-8px)" }], { duration: 180, easing: EASE_EXIT, fill: "forwards" });
      out.onfinish = () => {
        const from = content.offsetHeight;
        flushSync(clear);
        const to = content.offsetHeight;
        out.cancel();
        if (from !== to) content.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }], { duration: 480, easing: EASE_STANDARD });
        content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 120, easing: EASE_STANDARD, fill: "backwards" });
      };
    } else clear();
    setSending("sent");
    say("Message sent.");
    window.setTimeout(() => { if (mounted.current) setSending("idle"); }, 1600);
  };

  /* ---- Card drag: pull a card up to fold it back into its link. ---- */

  const drag = useRef<{ id: string; y: number; p: number; t: number; H: number; moved: boolean; pointer: number } | null>(null);
  const onCardPointerDown = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a")) return;
    if (e.pointerType === "touch" && !target.closest("[data-grip]")) return;
    const m = morphs.current.get(id);
    if (!m || !m.card || m.target !== 1) return;
    drag.current = { id, y: e.clientY, p: m.p, t: e.timeStamp, H: m.card.offsetHeight, moved: false, pointer: e.pointerId };
  };
  const onCardPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const m = morphs.current.get(d.id);
    if (!m) return;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 4) return;
      d.moved = true;
      m.dragging = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      rootRef.current?.setAttribute("data-dragging", "true");
    }
    const now = e.timeStamp;
    const raw = d.p - dy / (d.H * 0.8);
    const next = raw > 1 ? 1 + (raw - 1) * 0.08 : clamp01(raw);
    const dt = Math.max(1, now - d.t) / 1000;
    m.v = m.v * 0.6 + ((Math.min(1, next) - m.p) / dt) * 0.4;
    m.p = Math.min(1, next);
    d.t = now;
    if (!animating()) render(); else kick();
  };
  const onCardPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    const m = morphs.current.get(d.id);
    rootRef.current?.removeAttribute("data-dragging");
    if (!m || !d.moved) return;
    m.dragging = false;
    const fold = m.v < -1.4 || (m.p < 0.62 && m.v < 1.2);
    if (fold) setExpanded(d.id, false);
    else { m.target = 1; kick(); }
  };

  /* ---- Lifecycle ---- */

  useEffect(() => {
    mounted.current = true;
    const ctrls = aborts.current;
    return () => {
      mounted.current = false;
      ctrls.forEach(a => a.abort());
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  // Pause offscreen and in a hidden tab: open cards land where they are going and the shimmer stops.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let inView = true;
    const apply = () => {
      visible.current = inView && !document.hidden;
      root.dataset.running = visible.current ? "true" : "false";
      if (!visible.current) {
        if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
        kick();
      }
    };
    const io = new IntersectionObserver(entries => { inView = entries[entries.length - 1].isIntersecting; apply(); });
    io.observe(root);
    const ro = new ResizeObserver(() => { if (!raf.current) render(); });
    ro.observe(root);
    document.addEventListener("visibilitychange", apply);
    const onSel = () => saveRange();
    document.addEventListener("selectionchange", onSel);
    return () => {
      io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", apply);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [kick, render]);

  useLayoutEffect(() => { if (reduce || paused) kick(); }, [reduce, paused, kick]);

  // Autoplay: paste the first sample once the composer is in view, unless someone got there first.
  useEffect(() => {
    const root = rootRef.current;
    if (!autoPlay || paused || !samples.length || !root) return;
    let timer = 0;
    const io = new IntersectionObserver(entries => {
      if (!entries[entries.length - 1].isIntersecting) return;
      io.disconnect();
      timer = window.setTimeout(() => {
        if (touched.current || !mounted.current) return;
        if (linksRef.current.some(l => sameUrl(l.url, samples[0].url))) return;
        insertLink(samples[0].url, "end");
      }, reduce ? 0 : 650);
    }, { threshold: 0.5 });
    io.observe(root);
    return () => { io.disconnect(); window.clearTimeout(timer); };
    // Runs once per mount; later prop changes do not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSample = (sample: LinkUnfurlPreview) => {
    touched.current = true;
    const existing = linksRef.current.find(l => sameUrl(l.url, sample.url));
    if (existing) { toggle(existing.id); return; }
    insertLink(sample.url);
  };

  const hot = (id: string, on: boolean) => {
    const wrap = chipOf(id);
    if (wrap) { if (on) wrap.dataset.hot = "true"; else delete wrap.dataset.hot; }
  };

  const rootStyle = { ...style, ...(accent ? { "--lu-accent": accent } : null) } as CSSProperties;

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={rootStyle} data-running="true" data-reduced={reduce || paused ? "true" : undefined}>
      <div className={styles.composer}>
        <div ref={contentRef} className={styles.content}>
          <div
            ref={editorRef}
            className={styles.editor}
            role="textbox"
            aria-multiline="true"
            aria-label={label}
            aria-describedby={hintId}
            contentEditable
            suppressContentEditableWarning
            spellCheck
            data-empty={empty ? "true" : "false"}
            data-placeholder={placeholder}
            dangerouslySetInnerHTML={initialHtml}
            onPaste={onPaste}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onKeyUp={saveRange}
            onMouseUp={saveRange}
            onClick={onEditorClick}
            onFocus={() => { touched.current = true; }}
          />
          <p id={hintId} className={styles.srOnly}>Paste a link to preview it. Alt and Enter shows or collapses the preview of the link before the caret. Enter sends, Shift and Enter adds a line.</p>
          <div className={styles.lane}>
            {links.filter(l => l.status === "ready" && l.preview).map(l => {
              const pv = l.preview!;
              return (
                <div key={l.id} ref={bind(l.id, "wrap")} className={styles.wrap}>
                  <div ref={bind(l.id, "plate")} className={styles.plate} aria-hidden="true" />
                  <article
                    ref={bind(l.id, "card")}
                    className={styles.card}
                    aria-label={`${pv.site}: ${pv.title}`}
                    onPointerDown={onCardPointerDown(l.id)}
                    onPointerMove={onCardPointerMove}
                    onPointerUp={onCardPointerUp}
                    onPointerCancel={onCardPointerUp}
                    onPointerEnter={() => hot(l.id, true)}
                    onPointerLeave={() => hot(l.id, false)}
                  >
                    <div className={styles.head} data-grip="">
                      <span className={styles.fav} data-fav="" data-mono={pv.favicon ? undefined : "true"} aria-hidden="true">
                        {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
                        {pv.favicon ? <img src={pv.favicon} alt="" width={16} height={16} draggable={false} /> : pv.site.charAt(0).toUpperCase()}
                      </span>
                      <span className={styles.site}>{pv.site}</span>
                      <button type="button" className={styles.iconButton} onClick={() => setExpanded(l.id, false)} aria-label={`Collapse preview of ${pv.title}`}>
                        <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      <button type="button" className={styles.iconButton} onClick={() => removeLink(l.id)} aria-label={`Remove link to ${pv.title}`}>
                        <X size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                    <div ref={bind(l.id, "body")} className={styles.body}>
                      <a className={styles.title} href={pv.url} target="_blank" rel="noreferrer">{pv.title}</a>
                      {pv.description ? <p className={styles.description}>{pv.description}</p> : null}
                      {pv.image ? (
                        <div className={styles.media}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
                          <img ref={bind(l.id, "media")} src={pv.image} alt={pv.imageAlt ?? ""} draggable={false} decoding="async" />
                          {pv.duration ? (
                            <span className={styles.play} aria-hidden="true">
                              <Play size={14} strokeWidth={1.75} fill="currentColor" />
                              <span>{pv.duration}</span>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </article>
                </div>
              );
            })}
          </div>
        </div>
        <div className={styles.toolbar}>
          {samples.length ? (
            <div className={styles.samples} role="group" aria-label="Sample links">
              <span className={styles.tryLabel} aria-hidden="true">Try</span>
              {samples.map(s => {
                const existing = links.find(l => sameUrl(l.url, s.url));
                const name = existing
                  ? existing.status === "ready" ? `${existing.expanded ? "Collapse" : "Show"} ${s.site} preview` : `${s.site} link is loading`
                  : `Paste ${s.site} link`;
                return (
                  <button key={s.url} type="button" className={styles.sample} onClick={() => onSample(s)} aria-label={name} data-active={existing ? "true" : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
                    {s.favicon ? <img src={s.favicon} alt="" width={14} height={14} draggable={false} /> : null}
                    <span>{s.site}</span>
                  </button>
                );
              })}
            </div>
          ) : <span />}
          <button
            type="button"
            className={styles.send}
            onClick={() => void send()}
            aria-label={sending === "sent" ? "Message sent" : sendLabel}
            aria-disabled={empty || sending === "pending" ? "true" : undefined}
            data-state={sending}
          >
            <span className={styles.sendIcon} data-show={sending !== "sent" ? "true" : "false"}><ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" /></span>
            <span className={styles.sendIcon} data-show={sending === "sent" ? "true" : "false"}><Check size={18} strokeWidth={1.75} aria-hidden="true" /></span>
          </button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <p className={styles.srOnly} role="status" aria-live="polite">{announce}</p>
    </div>
  );
}

export default LinkUnfurl;
