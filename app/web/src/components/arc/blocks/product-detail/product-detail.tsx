"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { AnimatePresence, animate, motion, useInView, useMotionValue, useReducedMotion } from "motion/react";
import type { PanInfo } from "motion/react";
import { Bell, Check, ChevronDown, ChevronLeft, ChevronRight, Heart, Minus, Package, Plus, RotateCcw, ShieldCheck, ShoppingBag, Star } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { sampleProduct } from "./product-detail-data";
import type { DetailImage, DetailProduct } from "./product-detail-data";
import styles from "./product-detail.module.css";

/**
 * A product detail page: a swipeable gallery with thumbnails, finish and size variants, a quantity stepper, and an add to
 * bag button that confirms in place while the bag count rolls. Below sit shipping promises, a reviews summary whose bars
 * fill on view, and a details accordion. Sold out combinations offer a notify me action instead.
 */

export type { DetailFinish, DetailImage, DetailProduct, DetailSection, DetailSize } from "./product-detail-data";
export interface DetailSelection { productId: string; finish: string; size: string; quantity: number; unitPrice: number }

export interface ProductDetailProps {
  product?: DetailProduct;
  defaultFinish?: string;
  defaultSize?: string;
  /** Adds the selection to the bag. Return a promise to show a pending state; reject it to show an error. */
  onAddToCart?: (selection: DetailSelection) => void | Promise<void>;
  /** Called when someone asks to hear about a sold out combination. */
  onNotify?: (selection: Omit<DetailSelection, "quantity">) => void;
  onWishlistChange?: (saved: boolean) => void;
  /** Items already in the bag. */
  defaultCartCount?: number;
  maxQuantity?: number;
  currency?: string;
  locale?: string;
  className?: string;
}

type AddState = "idle" | "adding" | "added" | "error";
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const shippingIcons = [Package, RotateCcw, ShieldCheck];
const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");
/** Apple's momentum projection: where a flick would come to rest. */
const project = (velocity: number, rate = 0.998) => (velocity / 1000) * rate / (1 - rate);

function Roll({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const chars = Array.from(text);
  return <span className={styles.roll}>
    <span aria-hidden="true" className={styles.rollChars}>
      {chars.map((char, index) => {
        const key = chars.length - index;
        if (!/\d/.test(char)) return <span key={`s${key}`}>{char}</span>;
        return <span key={key} className={styles.rollDigit}>
          <motion.span className={styles.rollStrip} initial={false} animate={{ y: `${Number(char) * -10}%` }} transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}>
            {DIGITS.map(digit => <span key={digit}>{digit}</span>)}
          </motion.span>
        </span>;
      })}
    </span>
    <span className={styles.srOnly}>{text}</span>
  </span>;
}

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return <span className={styles.stars} aria-hidden="true">
    <span className={styles.starsBase}>{[0, 1, 2, 3, 4].map(index => <Star key={index} size={size} strokeWidth={1.5} />)}</span>
    <span className={styles.starsFill} style={{ width: `${(value / 5) * 100}%` }}>{[0, 1, 2, 3, 4].map(index => <Star key={index} size={size} strokeWidth={1.5} />)}</span>
  </span>;
}

/** Arrow keys move a radio group's selection and focus, the way native radios do. */
function radioKeys(event: ReactKeyboardEvent<HTMLElement>, ids: string[], current: string, choose: (id: string) => void, isEnabled: (id: string) => boolean = () => true) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  let index = ids.indexOf(current);
  for (let tries = 0; tries < ids.length; tries += 1) {
    index = (index + step + ids.length) % ids.length;
    if (isEnabled(ids[index])) break;
  }
  choose(ids[index]);
  const target = event.currentTarget.querySelector<HTMLElement>(`[data-radio="${ids[index]}"]`);
  target?.focus();
}

function Gallery({ images, name }: { images: DetailImage[]; name: string }) {
  const reduced = useReducedMotion() ?? false;
  const ringId = useId();
  const [index, setIndex] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const indexRef = useRef(0);
  const x = useMotionValue(0);
  const count = images.length;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => { width.current = element.clientWidth; x.set(-indexRef.current * width.current); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [x]);

  const go = useCallback((next: number, velocity = 0) => {
    const target = Math.max(0, Math.min(count - 1, next));
    indexRef.current = target;
    setIndex(target);
    animate(x, -target * width.current, reduced ? { duration: 0 } : { type: "spring", visualDuration: 0.42, bounce: velocity ? 0.14 : 0.06, velocity });
  }, [count, reduced, x]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const w = width.current || 1;
    const resting = x.get() + project(info.velocity.x);
    const nearest = Math.round(-resting / w);
    go(Math.max(indexRef.current - 1, Math.min(indexRef.current + 1, nearest)), info.velocity.x);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") { event.preventDefault(); go(indexRef.current + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(indexRef.current - 1); }
  };

  return <div className={styles.gallery}>
    <div ref={viewport} className={styles.viewport} role="region" aria-roledescription="carousel" aria-label={`${name} photos`} tabIndex={0} onKeyDown={onKey}>
      <motion.div className={styles.track} style={{ x }} drag={count > 1 ? "x" : false} dragConstraints={viewport} dragElastic={0.16} dragMomentum={false} onDragEnd={onDragEnd}>
        {images.map((image, slide) => <div key={slide} className={styles.slide} role="group" aria-roledescription="slide" aria-label={`${slide + 1} of ${count}`} aria-hidden={slide !== index}>
          <AnimatePresence initial={false}>
            <motion.div key={image.src} className={styles.slideImage} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.standard, ease: motionTokens.ease.standard }}>
              <Image src={image.src} alt={image.alt} fill sizes="(max-width: 760px) 100vw, 560px" draggable={false} priority={slide === 0} />
            </motion.div>
          </AnimatePresence>
        </div>)}
      </motion.div>
      {count > 1 ? <>
        <button type="button" className={cx(styles.arrow, styles.arrowPrev)} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous photo" tabIndex={-1}><ChevronLeft size={18} strokeWidth={1.75} /></button>
        <button type="button" className={cx(styles.arrow, styles.arrowNext)} onClick={() => go(index + 1)} disabled={index === count - 1} aria-label="Next photo" tabIndex={-1}><ChevronRight size={18} strokeWidth={1.75} /></button>
        <span className={styles.counter} aria-live="polite"><Roll text={String(index + 1)} /><span aria-hidden="true">/</span>{count}</span>
      </> : null}
    </div>
    {count > 1 ? <div className={styles.thumbs} role="group" aria-label="Choose a photo">
      {images.map((image, slide) => <button key={slide} type="button" className={styles.thumb} aria-label={`Show photo ${slide + 1} of ${count}`} aria-current={slide === index || undefined} onClick={() => go(slide)}>
        <AnimatePresence initial={false}>
          <motion.span key={image.src} className={styles.thumbImage} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.standard }}>
            <Image src={image.src} alt="" fill sizes="80px" draggable={false} />
          </motion.span>
        </AnimatePresence>
        {slide === index ? <motion.span layoutId={ringId} className={styles.thumbRing} transition={reduced ? { duration: 0 } : motionTokens.spring.snappy} /> : null}
      </button>)}
    </div> : null}
  </div>;
}

export function ProductDetail({
  product = sampleProduct,
  defaultFinish,
  defaultSize,
  onAddToCart,
  onNotify,
  onWishlistChange,
  defaultCartCount = 0,
  maxQuantity = 9,
  currency = "USD",
  locale = "en-US",
  className,
}: ProductDetailProps) {
  const uid = useId();
  const reduced = useReducedMotion() ?? false;
  const money = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }), [locale, currency]);
  const [finishId, setFinishId] = useState(defaultFinish ?? product.finishes[0]?.id ?? "");
  const [sizeId, setSizeId] = useState(defaultSize ?? product.sizes[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [saved, setSaved] = useState(false);
  const [cart, setCart] = useState(defaultCartCount);
  const [addState, setAddState] = useState<AddState>("idle");
  const [notified, setNotified] = useState<string[]>([]);
  const [openSections, setOpenSections] = useState<string[]>([product.sections[0]?.id ?? ""]);
  const [announcement, setAnnouncement] = useState("");
  const alive = useRef(true);
  const barsRef = useRef<HTMLUListElement>(null);
  const barsInView = useInView(barsRef, { once: true, margin: "-40px" });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const finish = product.finishes.find(item => item.id === finishId) ?? product.finishes[0];
  const size = product.sizes.find(item => item.id === sizeId) ?? product.sizes[0];
  const soldOut = (candidate = size) => Boolean(candidate?.soldOutIn?.includes(finish.id));
  const unavailable = soldOut();
  const comboKey = `${finish.id}:${size.id}`;
  const total = product.distribution.reduce((sum, value) => sum + value, 0) || 1;

  useEffect(() => {
    if (addState !== "added" && addState !== "error") return;
    const timer = window.setTimeout(() => setAddState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [addState]);

  const chooseFinish = (id: string) => { setFinishId(id); setAddState("idle"); };
  const chooseSize = (id: string) => { setSizeId(id); setAddState("idle"); };

  const addToBag = async () => {
    if (addState === "adding" || unavailable) return;
    const selection: DetailSelection = { productId: product.id, finish: finish.id, size: size.id, quantity, unitPrice: size.price };
    setAddState("adding");
    try {
      if (onAddToCart) await onAddToCart(selection);
      else await new Promise(resolve => window.setTimeout(resolve, 650));
      if (!alive.current) return;
      setCart(count => count + quantity);
      setAddState("added");
      setAnnouncement(`${quantity} ${product.name} added to bag`);
    } catch {
      if (!alive.current) return;
      setAddState("error");
      setAnnouncement("Could not add to bag. Try again.");
    }
  };

  const notify = () => {
    if (notified.includes(comboKey)) return;
    setNotified(list => [...list, comboKey]);
    onNotify?.({ productId: product.id, finish: finish.id, size: size.id, unitPrice: size.price });
    setAnnouncement(`We will email you when ${finish.name}, ${size.name} is back`);
  };

  const toggleSection = (id: string) => setOpenSections(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  const toggleSaved = () => { const next = !saved; setSaved(next); onWishlistChange?.(next); };

  const buttonLabel = addState === "adding" ? "Adding" : addState === "added" ? "Added to bag" : addState === "error" ? "Try again" : `Add to bag · ${money.format(size.price * quantity)}`;

  return <div className={cx(styles.root, className)}>
    <div className={styles.scroller}>
      <header className={styles.top}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}><span>Shop</span><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /><span>{product.collection}</span><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /><span aria-current="page">{product.name}</span></nav>
        <span className={styles.bag} role="img" aria-label={`${cart} items in bag`}>
          <motion.span key={cart} className={styles.bagIcon} initial={reduced || cart === defaultCartCount ? false : { scale: 1.2, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={motionTokens.spring.snappy}><ShoppingBag size={18} strokeWidth={1.75} aria-hidden="true" /></motion.span>
          <span aria-hidden="true"><Roll text={String(cart)} /></span>
        </span>
      </header>

      <div className={styles.layout}>
        <div className={styles.media}><Gallery images={finish.images} name={product.name} /></div>

        <div className={styles.info}>
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              <h2>{product.name}</h2>
              <button type="button" className={styles.save} aria-pressed={saved} aria-label={saved ? "Remove from saved" : "Save for later"} onClick={toggleSaved}>
                <motion.span key={String(saved)} className={styles.saveIcon} initial={reduced || !saved ? false : { scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: "spring", visualDuration: 0.3, bounce: 0.45 }}><Heart size={18} strokeWidth={1.75} /></motion.span>
              </button>
            </div>
            <div className={styles.priceRow}>
              <span className={styles.price}><Roll text={money.format(size.price)} /></span>
              <a className={styles.ratingLink} href={`#${uid}-reviews`}><Stars value={product.rating} /><span>{product.rating.toFixed(1)}</span><span className={styles.muted}>({product.reviewCount})</span></a>
            </div>
            <p className={styles.summary}>{product.summary}</p>
          </div>

          <div className={styles.option}>
            <p className={styles.optionLabel} id={`${uid}-finish`}>Finish <span className={styles.muted}>{finish.name}</span></p>
            <div className={styles.swatches} role="radiogroup" aria-labelledby={`${uid}-finish`} onKeyDown={event => radioKeys(event, product.finishes.map(item => item.id), finish.id, chooseFinish)}>
              {product.finishes.map(item => <button key={item.id} type="button" role="radio" data-radio={item.id} aria-checked={item.id === finish.id} tabIndex={item.id === finish.id ? 0 : -1} aria-label={item.name} title={item.name} className={styles.swatch} onClick={() => chooseFinish(item.id)}>
                <span className={styles.swatchFill} style={{ background: item.swatch }} />
              </button>)}
            </div>
          </div>

          <div className={styles.option}>
            <p className={styles.optionLabel} id={`${uid}-size`}>Size <span className={styles.muted}>{size.note}</span></p>
            <div className={styles.sizes} role="radiogroup" aria-labelledby={`${uid}-size`} onKeyDown={event => radioKeys(event, product.sizes.map(item => item.id), size.id, chooseSize)}>
              {product.sizes.map(item => {
                const out = soldOut(item);
                return <button key={item.id} type="button" role="radio" data-radio={item.id} aria-checked={item.id === size.id} tabIndex={item.id === size.id ? 0 : -1} className={styles.sizeCard} data-out={out || undefined} onClick={() => chooseSize(item.id)}>
                  <span className={styles.sizeName}>{item.name}</span>
                  <span className={styles.sizeMeta}>{out ? "Sold out" : money.format(item.price)}</span>
                </button>;
              })}
            </div>
          </div>

          <div className={styles.buyRow}>
            <div className={styles.stepper} role="group" aria-label="Quantity">
              <button type="button" onClick={() => setQuantity(value => Math.max(1, value - 1))} disabled={quantity <= 1 || unavailable} aria-label="Decrease quantity"><Minus size={15} strokeWidth={1.75} /></button>
              <span className={styles.qty} aria-live="polite"><Roll text={String(quantity)} /></span>
              <button type="button" onClick={() => setQuantity(value => Math.min(maxQuantity, value + 1))} disabled={quantity >= maxQuantity || unavailable} aria-label="Increase quantity"><Plus size={15} strokeWidth={1.75} /></button>
            </div>
            {unavailable ? <button type="button" className={styles.notify} data-done={notified.includes(comboKey) || undefined} onClick={notify}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={String(notified.includes(comboKey))} className={styles.buttonInner} initial={{ opacity: 0, y: reduced ? 0 : 6, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: reduced ? 0 : -6, filter: "blur(2px)" }} transition={{ duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }}>
                  {notified.includes(comboKey) ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />We will email you</> : <><Bell size={16} strokeWidth={1.75} aria-hidden="true" />Notify me when it is back</>}
                </motion.span>
              </AnimatePresence>
            </button> : <button type="button" className={styles.addButton} data-state={addState} aria-busy={addState === "adding"} onClick={addToBag}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={addState === "idle" ? `idle-${buttonLabel}` : addState} className={styles.buttonInner} initial={{ opacity: 0, y: reduced ? 0 : 6, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: reduced ? 0 : -6, filter: "blur(2px)" }} transition={{ duration: addState === "idle" ? motionTokens.duration.fast : motionTokens.duration.standard, ease: motionTokens.ease.enter }}>
                  {addState === "adding" ? <span className={styles.spinner} aria-hidden="true" /> : addState === "added" ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : null}
                  {buttonLabel}
                </motion.span>
              </AnimatePresence>
            </button>}
          </div>

          <ul className={styles.shipping}>
            {product.shipping.map((item, index) => {
              const Icon = shippingIcons[index % shippingIcons.length];
              return <li key={item.title}><Icon size={18} strokeWidth={1.75} aria-hidden="true" /><span><strong>{item.title}</strong><span className={styles.muted}>{item.text}</span></span></li>;
            })}
          </ul>

          <section className={styles.reviews} id={`${uid}-reviews`} aria-label="Reviews summary">
            <div className={styles.score}>
              <span className={styles.scoreValue}>{product.rating.toFixed(1)}</span>
              <Stars value={product.rating} size={16} />
              <span className={styles.muted}>{product.reviewCount} reviews</span>
            </div>
            <ul ref={barsRef} className={styles.bars}>
              {product.distribution.map((value, index) => <li key={index} aria-label={`${5 - index} stars: ${value} reviews`}>
                <span className={styles.barLabel} aria-hidden="true">{5 - index}</span>
                <span className={styles.bar} aria-hidden="true"><motion.span className={styles.barFill} initial={false} animate={{ scaleX: barsInView || reduced ? value / total : 0 }} transition={reduced ? { duration: 0 } : { ...motionTokens.spring.smooth, delay: index * 0.05 }} /></span>
                <span className={styles.barCount} aria-hidden="true">{value}</span>
              </li>)}
            </ul>
          </section>

          <div className={styles.accordion}>
            {product.sections.map(section => {
              const open = openSections.includes(section.id);
              return <div key={section.id} className={styles.section}>
                <h3><button type="button" className={styles.sectionButton} aria-expanded={open} aria-controls={`${uid}-${section.id}`} onClick={() => toggleSection(section.id)}>
                  {section.title}<ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.sectionChevron} data-open={open || undefined} />
                </button></h3>
                <AnimatePresence initial={false}>
                  {open ? <motion.div id={`${uid}-${section.id}`} key="body" className={styles.sectionBody} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
                    <div className={styles.sectionText}>{section.body.map(line => <p key={line}>{line}</p>)}</div>
                  </motion.div> : null}
                </AnimatePresence>
              </div>;
            })}
          </div>
        </div>
      </div>
    </div>
    <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
  </div>;
}

export default ProductDetail;
