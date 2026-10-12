"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { PanInfo, Transition, Variants } from "motion/react";
import { Check, Minus, Plus, ShoppingBag, Tag, Trash2, Truck, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import Button from "../../button/button";
import { photo } from "../../lib/media";
import type { PhotoId } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./cart-drawer.module.css";

type Product = { id: string; name: string; detail: string; price: number; photo: PhotoId };
type Line = { id: string; qty: number };
type Rect = { x: number; y: number; w: number; h: number };
type Flight = { key: number; product: Product; from: Rect; to: { x: number; y: number } };
type Phase = "cart" | "placing" | "done";

const PRODUCTS: Product[] = [
  { id: "chair", name: "Oak lounge chair", detail: "Woven oak, sheepskin", price: 1240, photo: "lounge-chair" },
  { id: "lamp", name: "Dome table lamp", detail: "Opal glass, 2700K", price: 186, photo: "table-lamp" },
  { id: "carafe", name: "Ribbed carafe", detail: "Mouth-blown glass, 1 L", price: 64, photo: "glass-carafe" },
  { id: "cups", name: "Stoneware cups", detail: "Set of two, speckled", price: 48, photo: "stoneware-cups" },
  { id: "bowls", name: "Nesting bowls", detail: "Glazed stoneware, pair", price: 56, photo: "stacked-bowls" },
  { id: "throw", name: "Linen throw", detail: "Stonewashed, fringed", price: 118, photo: "linen-throw" },
];
const byId = new Map(PRODUCTS.map(product => [product.id, product]));
const FREE_SHIPPING = 250, SHIPPING = 12, PROMO = "STUDIO10", PROMO_RATE = .1, TRAVEL = 780;
const START: Line[] = [{ id: "carafe", qty: 1 }];

const { spring, duration, ease } = motionTokens;
type Bezier = [number, number, number, number];
const enter = [...ease.enter] as Bezier, standard = [...ease.standard] as Bezier;
/** Duration based springs restated as stiffness and damping, so a retarget keeps its velocity. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const DRAWER = physical(.42, 0), SNAP = physical(.34, .18), MORPH = physical(.5, .14);
const money = (value: number) => `$${value.toLocaleString("en-US")}`;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** A price or count that rolls to its new value in the surrounding type. */
function Num({ value, prefix = "" }: { value: number; prefix?: string }) {
  return <span className={styles.num}><AnimatedCounter value={value} prefix={prefix} /></span>;
}

/** Copy keyed by its text crossfades in place. Right aligned copy anchors the leaving line to its right edge. */
function Swap({ text, reduced, className, anchor = "left" }: { text: string; reduced: boolean; className?: string; anchor?: "left" | "right" }) {
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false} anchorX={anchor}>
      <motion.span key={text} initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.4em" }} animate={{ opacity: 1, y: "0em" }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.4em", transition: { duration: duration.fast, ease: standard } }}
        transition={reduced ? { duration: duration.instant } : { duration: duration.standard, ease: enter }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

/** Height follows the content on a spring, so a slot that swaps what it holds reshapes instead of jumping. */
function Fit({ children, reduced, className }: { children: ReactNode; reduced: boolean; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={[styles.fit, className].filter(Boolean).join(" ")} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : spring.smooth}>
    <div ref={inner} className={styles.fitInner}>{children}</div>
  </motion.div>;
}

/** The product photo lifts off its card and arcs into the cart. The count only changes when it lands. */
function Flyer({ flight, onLand }: { flight: Flight; onLand: (key: number) => void }) {
  const t = useMotionValue(0);
  const land = useEffectEvent(() => onLand(flight.key));
  const { from, to } = flight;
  const start = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  // One control point above both ends makes the arc; the photo shrinks to a chip as it travels.
  const peak = { x: start.x + (to.x - start.x) * .55, y: Math.max(8, Math.min(start.y, to.y) - Math.min(160, Math.abs(to.x - start.x) * .35)) };
  const point = (p: number, a: number, b: number, c: number) => (1 - p) * (1 - p) * a + 2 * (1 - p) * p * b + p * p * c;
  const width = useTransform(t, p => from.w + (26 - from.w) * Math.min(1, p * 1.25));
  const height = useTransform(t, p => from.h + (26 - from.h) * Math.min(1, p * 1.25));
  const transform = useTransform(t, p => `translate3d(${point(p, start.x, peak.x, to.x).toFixed(2)}px, ${point(p, start.y, peak.y, to.y).toFixed(2)}px, 0) translate(-50%, -50%) rotate(${(-10 * Math.sin(p * Math.PI)).toFixed(2)}deg)`);
  const radius = useTransform(t, p => 16 - 3 * p);
  const opacity = useTransform(t, [0, .86, 1], [1, 1, 0]);
  const shadow = useTransform(t, p => `0 ${(4 + 14 * Math.sin(p * Math.PI)).toFixed(1)}px ${(10 + 26 * Math.sin(p * Math.PI)).toFixed(1)}px oklch(0% 0 0 / ${(.08 + .12 * Math.sin(p * Math.PI)).toFixed(3)})`);
  useEffect(() => {
    const controls = animate(t, 1, { duration: TRAVEL / 1000, ease: [.32, 0, .18, 1] });
    controls.then(() => land());
    return () => controls.stop();
  }, [t]);
  return <motion.div className={styles.flyer} style={{ width, height, transform, borderRadius: radius, opacity, boxShadow: shadow }} aria-hidden="true">
    <Image src={photo(flight.product.photo).src} alt="" fill sizes="240px" />
  </motion.div>;
}

type RowProps = { line: Line; product: Product; reduced: boolean; onQty: (id: string, qty: number) => void; onRemove: (id: string) => void };

/** A cart line. Swipe it left to remove it, or use the stepper and the remove button. */
function CartRow({ line, product, reduced, onQty, onRemove }: RowProps) {
  const x = useMotionValue(0);
  const faceRef = useRef<HTMLDivElement>(null);
  const reveal = useTransform(x, [-140, -28, 0], [1, .35, 0]);
  const iconScale = useTransform(x, [-120, -40], [1, .7]);
  const [armed, setArmed] = useState(false);

  const onDrag = (_: unknown, info: PanInfo) => setArmed(info.offset.x < -110);
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const width = faceRef.current?.offsetWidth ?? 320;
    // A quick flick removes the line even if it has not travelled far.
    if (info.offset.x < -110 || (info.velocity.x < -520 && info.offset.x < -24)) {
      animate(x, -width, { ...physical(.28, 0), velocity: info.velocity.x });
      onRemove(line.id);
      return;
    }
    setArmed(false);
    animate(x, 0, { ...SNAP, velocity: info.velocity.x });
  };

  return <motion.li className={styles.row}
    initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
    exit={reduced ? { opacity: 0, transition: { duration: .12 } } : { opacity: 0, height: 0, transition: { height: { ...spring.smooth, delay: .06 }, opacity: { duration: duration.fast } } }}
    transition={reduced ? { duration: .12 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: enter } }}>
    <div className={styles.rowInner}>
      <motion.div className={styles.removeLayer} data-armed={armed || undefined} style={{ opacity: reveal }} aria-hidden="true">
        <motion.span style={{ scale: iconScale }} className={styles.removeHint}><Trash2 size={16} strokeWidth={1.75} />Remove</motion.span>
      </motion.div>
      <motion.div ref={faceRef} className={styles.rowFace} style={{ x }} drag={reduced ? false : "x"} dragDirectionLock dragMomentum={false}
        dragConstraints={{ left: -400, right: 0 }} dragElastic={{ left: .02, right: .08 }} onDrag={onDrag} onDragEnd={onDragEnd}>
        <span className={styles.thumb}><Image src={photo(product.photo).src} alt="" fill sizes="64px" draggable={false} /></span>
        <div className={styles.rowText}>
          <p className={styles.rowName}>{product.name}</p>
          <p className={styles.rowDetail}>{product.detail}</p>
          <div className={styles.stepper} role="group" aria-label={`${product.name} quantity`}>
            <button type="button" className={styles.stepButton} aria-label={line.qty === 1 ? `Remove ${product.name}` : `Decrease ${product.name} quantity`}
              onClick={() => line.qty === 1 ? onRemove(line.id) : onQty(line.id, line.qty - 1)}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={line.qty === 1 ? "trash" : "minus"} className={styles.stepIcon} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .5, rotate: -30 }} animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .5, rotate: 30 }} transition={reduced ? { duration: .1 } : spring.snappy}>
                  {line.qty === 1 ? <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /> : <Minus size={14} strokeWidth={1.75} aria-hidden="true" />}
                </motion.span>
              </AnimatePresence>
            </button>
            <span className={styles.qty}><Num value={line.qty} /></span>
            <button type="button" className={styles.stepButton} aria-label={`Increase ${product.name} quantity`} disabled={line.qty >= 9} onClick={() => onQty(line.id, line.qty + 1)}>
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className={styles.rowEnd}>
          <span className={styles.linePrice}><Num value={product.price * line.qty} prefix="$" /></span>
          <button type="button" className={styles.iconButton} aria-label={`Remove ${product.name}`} onClick={() => onRemove(line.id)}><X size={15} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      </motion.div>
    </div>
  </motion.li>;
}

const bodyVariants: Variants = {
  shown: { opacity: 1, transition: { duration: duration.standard, ease: enter } },
  gone: { opacity: 0, transition: { duration: duration.fast, ease: standard } },
};

export function CartDrawer() {
  const reduced = useReducedFlag();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const rootRef = useRef<HTMLElement>(null);
  const cartRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const images = useRef(new Map<string, HTMLElement>());
  const flightKey = useRef(0);
  const timers = useRef<number[]>([]);

  const [lines, setLines] = useState<Line[]>(START);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<Record<string, number>>({});
  const [pulse, setPulse] = useState(0);
  const [code, setCode] = useState("");
  const [promo, setPromo] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("cart");
  const [order, setOrder] = useState<{ items: number; total: number } | null>(null);
  const [live, setLive] = useState("");
  // Each opening gets its own checkout morph id, so a reopened drawer never resumes the button from the last confirmation disc.
  const [visit, setVisit] = useState(0);

  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  const inFlight = flights.length;
  const shownCount = Math.max(0, count - inFlight);
  const subtotal = lines.reduce((sum, line) => sum + (byId.get(line.id)?.price ?? 0) * line.qty, 0);
  const discount = promo ? Math.round(subtotal * PROMO_RATE) : 0;
  const freeShipping = subtotal >= FREE_SHIPPING;
  const shipping = !lines.length || freeShipping ? 0 : SHIPPING;
  const total = subtotal - discount + shipping;
  const progress = Math.min(1, subtotal / FREE_SHIPPING);

  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  // The drawer takes focus when it opens and hands it back to the cart button when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) cartRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  const onEscape = useEffectEvent((event: KeyboardEvent) => { if (event.key === "Escape" && phase !== "placing") setOpen(false); });
  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => onEscape(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [open]);

  function add(product: Product) {
    setLines(current => current.some(line => line.id === product.id)
      ? current.map(line => line.id === product.id ? { ...line, qty: Math.min(9, line.qty + 1) } : line)
      : [...current, { id: product.id, qty: 1 }]);
    setAdded(current => ({ ...current, [product.id]: (current[product.id] ?? 0) + 1 }));
    later(() => setAdded(current => ({ ...current, [product.id]: Math.max(0, (current[product.id] ?? 1) - 1) })), 1400);
    setLive(`Added ${product.name} to your cart`);
    if (phase === "done") { setPhase("cart"); setOrder(null); }
    const image = images.current.get(product.id), cart = cartRef.current, root = rootRef.current;
    if (reduced || !image || !cart || !root) { bump(); return; }
    const frame = root.getBoundingClientRect(), a = image.getBoundingClientRect(), b = cart.getBoundingClientRect();
    flightKey.current += 1;
    setFlights(current => [...current, {
      key: flightKey.current, product,
      from: { x: a.left - frame.left, y: a.top - frame.top, w: a.width, h: a.height },
      to: { x: b.left - frame.left + 22, y: b.top - frame.top + b.height / 2 },
    }]);
  }

  function bump() {
    setPulse(value => value + 1);
    const node = cartRef.current;
    if (!node || reduced) return;
    animate(node, { scale: [1, 1.09, .98, 1] }, { duration: .42, ease: "easeOut", times: [0, .35, .7, 1] });
  }

  function land(key: number) {
    setFlights(current => current.filter(flight => flight.key !== key));
    bump();
  }

  function setQty(id: string, qty: number) {
    setLines(current => current.map(line => line.id === id ? { ...line, qty } : line));
  }

  function remove(id: string) {
    setLines(current => current.filter(line => line.id !== id));
    setLive(`Removed ${byId.get(id)?.name ?? "item"}`);
  }

  function applyPromo(event: FormEvent) {
    event.preventDefault();
    const value = code.trim().toUpperCase();
    if (!value) { inputRef.current?.focus(); return; }
    if (value === PROMO) { setPromo(PROMO); setPromoError(null); setCode(""); setLive("Promo code applied, 10% off"); return; }
    setPromoError(`${value} isn't a valid code`);
    const node = inputRef.current?.parentElement;
    if (node && !reduced) animate(node, { x: [0, -6, 5, -3, 2, 0] }, { duration: .36, ease: "easeOut" });
  }

  function checkout() {
    if (!lines.length || phase !== "cart") return;
    setPhase("placing");
    setLive("Placing your order");
    later(() => {
      setOrder({ items: count, total });
      setPhase("done");
      setLive(`Order placed. ${count} ${count === 1 ? "item" : "items"}, ${money(total)}.`);
    }, 1300);
  }

  function continueShopping() {
    setLines([]);
    setPromo(null);
    setCode("");
    setPromoError(null);
    setOpen(false);
    later(() => { setPhase("cart"); setOrder(null); }, 420);
  }

  const away = FREE_SHIPPING - subtotal;
  const morph = reduced ? { duration: 0 } : MORPH;
  const drawerMotion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: .16 } }
    : { initial: { x: "104%" }, animate: { x: "0%" }, exit: { x: "104%", transition: physical(.34, 0) }, transition: DRAWER };

  return <section ref={rootRef} className={styles.root} aria-labelledby={`${uid}-title`}>
    <div className={styles.shop} inert={open || undefined}>
      <header className={styles.header}>
        <h2 id={`${uid}-title`} className={styles.title}>New in the studio</h2>
        <div className={styles.cartWrap}>
          <AnimatePresence>
            {pulse > 0 && !reduced && <motion.span key={pulse} className={styles.ring} aria-hidden="true" initial={{ opacity: .45, scale: 1 }} animate={{ opacity: 0, scale: 1.45 }} transition={{ duration: .6, ease: enter }} />}
          </AnimatePresence>
          <button ref={cartRef} type="button" className={styles.cart} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${uid}-drawer`}
            aria-label={`Cart, ${shownCount} ${shownCount === 1 ? "item" : "items"}`} onClick={() => { setVisit(count => count + 1); setOpen(true); }}>
            <ShoppingBag size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles.cartLabel}>Cart</span>
            <AnimatePresence initial={false}>
              {shownCount > 0 && <motion.span key="badge" className={styles.badge} aria-hidden="true"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .4 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .4 }}
                transition={reduced ? { duration: .12 } : spring.snappy}>
                <Num value={shownCount} />
              </motion.span>}
            </AnimatePresence>
          </button>
        </div>
      </header>

      <ul className={styles.grid}>
        {PRODUCTS.map(product => {
          const media = photo(product.photo);
          const justAdded = (added[product.id] ?? 0) > 0;
          return <li key={product.id} className={styles.card}>
            <span className={styles.imageFrame} ref={node => { if (node) images.current.set(product.id, node); else images.current.delete(product.id); }}>
              <Image src={media.src} alt={media.alt} fill sizes="(max-width: 640px) 50vw, 260px" />
            </span>
            <div className={styles.cardText}>
              <p className={styles.name}>{product.name}</p>
              <p className={styles.price}>{money(product.price)}</p>
            </div>
            <p className={styles.detail}>{product.detail}</p>
            <Button variant="secondary" size="sm" className={styles.addButton} onClick={() => add(product)} aria-label={`Add ${product.name} to cart`}>
              {justAdded ? <><Check size={15} strokeWidth={1.75} aria-hidden="true" />Added</> : <><Plus size={15} strokeWidth={1.75} aria-hidden="true" />Add to cart</>}
            </Button>
          </li>;
        })}
      </ul>
    </div>

    <div className={styles.flights} aria-hidden="true">
      {flights.map(flight => <Flyer key={flight.key} flight={flight} onLand={land} />)}
    </div>

    <AnimatePresence>
      {open && <motion.div key="scrim" className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: reduced ? .12 : .28, ease: standard }} onClick={() => { if (phase !== "placing") setOpen(false); }} aria-hidden="true" />}
      {open && <motion.aside key="drawer" id={`${uid}-drawer`} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby={`${uid}-drawer-title`} {...drawerMotion}>
        <header className={styles.drawerHead}>
          <h3 id={`${uid}-drawer-title`} className={styles.drawerTitle}>{phase === "done" ? "Order placed" : "Your cart"}</h3>
          {phase !== "done" && <span className={styles.drawerCount}><Num value={count} /> {count === 1 ? "item" : "items"}</span>}
          <button ref={closeRef} type="button" className={styles.iconButton} aria-label="Close cart" onClick={() => setOpen(false)} disabled={phase === "placing"}><X size={17} strokeWidth={1.75} aria-hidden="true" /></button>
        </header>

        <AnimatePresence initial={false} mode="popLayout">
          {phase !== "done" ? <motion.div key="cart" className={styles.drawerBody} variants={bodyVariants} initial="gone" animate="shown" exit="gone" inert={phase === "placing" || undefined}>
            {lines.length > 0 && <div className={styles.shipping} data-free={freeShipping || undefined}>
              <p className={styles.shippingText}>
                <Truck size={16} strokeWidth={1.75} aria-hidden="true" />
                <Swap reduced={reduced} text={freeShipping ? "Free shipping unlocked" : `${money(away)} away from free shipping`} />
              </p>
              <div className={styles.track} role="progressbar" aria-label="Progress to free shipping" aria-valuemin={0} aria-valuemax={FREE_SHIPPING} aria-valuenow={Math.min(subtotal, FREE_SHIPPING)}>
                <motion.span className={styles.fill} initial={false} animate={{ scaleX: progress }} transition={reduced ? { duration: 0 } : spring.smooth} />
              </div>
            </div>}

            <ul className={styles.lines}>
              <AnimatePresence initial={false}>
                {lines.map(line => {
                  const product = byId.get(line.id);
                  return product ? <CartRow key={line.id} line={line} product={product} reduced={reduced} onQty={setQty} onRemove={remove} /> : null;
                })}
              </AnimatePresence>
            </ul>
            <AnimatePresence initial={false}>
              {!lines.length && <motion.div key="empty" className={styles.empty} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: .12, duration: duration.standard } }} exit={{ opacity: 0, transition: { duration: .08 } }}>
                <ShoppingBag size={22} strokeWidth={1.5} aria-hidden="true" />
                <p>Your cart is empty</p>
                <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Keep browsing</Button>
              </motion.div>}
            </AnimatePresence>
          </motion.div> : <motion.div key="done" className={styles.done} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: reduced ? 0 : .12, duration: duration.standard } }} exit={{ opacity: 0 }}>
            {/* The checkout button itself travels up and folds into this disc. */}
            <motion.div layoutId={`${uid}-checkout-${visit}`} className={styles.doneDisc} style={{ borderRadius: 999 }} transition={morph}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <motion.path d="M6.5 12.5l3.6 3.6 7.4-8" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .3, ease: enter, delay: reduced ? 0 : .38 }} />
              </svg>
            </motion.div>
            <p className={styles.doneTitle}>Thanks, Olivia</p>
            <p className={styles.doneBody}>Order A-20417 is confirmed and a receipt is on its way to olivia@bennett.studio.</p>
            {order && <dl className={styles.doneFacts}>
              <div><dt>Items</dt><dd>{order.items}</dd></div>
              <div><dt>Paid</dt><dd>{money(order.total)}</dd></div>
              <div><dt>Arrives</dt><dd>Oct 2 to Oct 4</dd></div>
            </dl>}
          </motion.div>}
        </AnimatePresence>

        <footer className={styles.drawerFoot}>
          <AnimatePresence initial={false}>
            {phase !== "done" && lines.length > 0 && <motion.div key="summary" className={styles.summaryWrap} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              transition={reduced ? { duration: .12 } : { height: spring.smooth, opacity: { duration: duration.fast } }} inert={phase === "placing" || undefined}>
              <div className={styles.summary}>
                <Fit reduced={reduced}>
                <AnimatePresence initial={false} mode="popLayout">
                  {promo ? <motion.div key="applied" className={styles.promoApplied} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} transition={reduced ? { duration: .12 } : spring.snappy}>
                    <Tag size={15} strokeWidth={1.75} aria-hidden="true" />
                    <span><strong>{promo}</strong> 10% off</span>
                    <button type="button" className={styles.textButton} onClick={() => { setPromo(null); setLive("Promo code removed"); }}>Remove</button>
                  </motion.div> : <motion.form key="form" className={styles.promo} onSubmit={applyPromo} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.fast }}>
                    <div className={styles.promoField} data-error={promoError ? "" : undefined}>
                      <input ref={inputRef} className={styles.promoInput} value={code} onChange={event => { setCode(event.target.value); setPromoError(null); }} placeholder="Promo code"
                        aria-label="Promo code" aria-invalid={!!promoError} aria-describedby={`${uid}-promo-note`} autoComplete="off" spellCheck={false} />
                      <button type="submit" className={styles.applyButton}>Apply</button>
                    </div>
                    <p id={`${uid}-promo-note`} className={styles.promoNote} data-error={promoError ? "" : undefined}>
                      <Swap reduced={reduced} text={promoError ?? `Try ${PROMO} for 10% off`} />
                    </p>
                  </motion.form>}
                </AnimatePresence>
                </Fit>

                <dl className={styles.totals}>
                  <div className={styles.totalRow}><dt>Subtotal</dt><dd><Num value={subtotal} prefix="$" /></dd></div>
                  <AnimatePresence initial={false}>
                    {discount > 0 && <motion.div key="discount" className={styles.totalRow} data-tone="discount" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      transition={reduced ? { duration: .12 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
                      <dt>Discount</dt><dd>−<Num value={discount} prefix="$" /></dd>
                    </motion.div>}
                  </AnimatePresence>
                  <div className={styles.totalRow}><dt>Shipping</dt><dd><Swap reduced={reduced} anchor="right" text={shipping ? money(shipping) : "Free"} /></dd></div>
                  <div className={styles.totalRow} data-tone="total"><dt>Total</dt><dd><Num value={total} prefix="$" /></dd></div>
                </dl>
              </div>
            </motion.div>}
          </AnimatePresence>

          {phase === "done"
            ? <motion.div className={styles.continueWrap} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: reduced ? 0 : .3, duration: duration.standard } }}>
              <Button variant="secondary" size="lg" className={styles.continue} onClick={continueShopping}>Continue shopping</Button>
            </motion.div>
            : <motion.button layoutId={`${uid}-checkout-${visit}`} type="button" className={styles.checkout} style={{ borderRadius: 18 }} transition={morph}
              onClick={checkout} disabled={!lines.length} aria-disabled={phase === "placing" || undefined} aria-busy={phase === "placing" || undefined}>
              <AnimatePresence mode="popLayout" initial={false}>
                {phase === "placing"
                  ? <motion.span key="placing" className={styles.checkoutLabel} data-center="" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: duration.standard, ease: enter }}>
                    <span className={styles.spinner} aria-hidden="true" />Placing order
                  </motion.span>
                  : <motion.span key="idle" className={styles.checkoutLabel} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: reduced ? 0 : -8, transition: { duration: duration.fast } }} transition={{ duration: duration.standard, ease: enter }}>
                    <span>Check out</span><Num value={total} prefix="$" />
                  </motion.span>}
              </AnimatePresence>
            </motion.button>}
        </footer>
      </motion.aside>}
    </AnimatePresence>

    <p className={styles.srOnly} aria-live="polite">{live}</p>
  </section>;
}

export default CartDrawer;
