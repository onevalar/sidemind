"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown, Plus, ShoppingBag, SlidersHorizontal, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { sampleColors, sampleProducts, sampleSizes } from "./product-listing-data";
import type { ListingColor, ListingProduct } from "./product-listing-data";
import styles from "./product-listing.module.css";

/**
 * A storefront listing: a filter sidebar with a dual price range, color swatches, sizes and a stock switch, a sort menu,
 * and product cards that swap to a second photo on hover. Quick add opens a size row inside the card and the bag count
 * rolls up. The grid reflows on a spring as filters change. Below 640px the filters move into a sheet.
 */

export type { ListingColor, ListingProduct } from "./product-listing-data";
export type ListingSort = "featured" | "price-asc" | "price-desc" | "newest";

export interface ProductListingProps {
  products?: ListingProduct[];
  colors?: ListingColor[];
  sizes?: string[];
  defaultSort?: ListingSort;
  /** Called when a product is added from its card. */
  onAddToCart?: (product: ListingProduct, size: string) => void;
  /** Items already in the bag. */
  defaultCartCount?: number;
  currency?: string;
  locale?: string;
  title?: string;
  className?: string;
}

const SORTS: { id: ListingSort; label: string }[] = [
  { id: "featured", label: "Featured" },
  { id: "newest", label: "Newest" },
  { id: "price-asc", label: "Price, low to high" },
  { id: "price-desc", label: "Price, high to low" },
];
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const STEP = 10;
const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");

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

function SortMenu({ value, onChange }: { value: ListingSort; onChange: (sort: ListingSort) => void }) {
  const uid = useId();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = SORTS.find(item => item.id === value) ?? SORTS[0];

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    const onDown = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const show = () => { setActive(Math.max(0, SORTS.findIndex(item => item.id === value))); setOpen(true); };
  const pick = (sort: ListingSort) => { onChange(sort); setOpen(false); buttonRef.current?.focus({ preventScroll: true }); };
  const onKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(SORTS.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(SORTS.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(SORTS[active].id); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); buttonRef.current?.focus({ preventScroll: true }); }
    else if (event.key === "Tab") setOpen(false);
  };

  return <div ref={wrapRef} className={styles.sort}>
    <button ref={buttonRef} type="button" className={styles.sortButton} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${uid}-list`} onClick={() => (open ? setOpen(false) : show())}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}>
      <span className={styles.sortLabel}>Sort</span><span>{current.label}</span><ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} data-open={open || undefined} />
    </button>
    <AnimatePresence>
      {open ? <motion.ul ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Sort products" tabIndex={-1} className={styles.sortMenu} aria-activedescendant={`${uid}-${SORTS[active].id}`} onKeyDown={onKey}
        initial={{ opacity: 0, scale: reduced ? 1 : 0.96, y: reduced ? 0 : -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: reduced ? 1 : 0.98, transition: { duration: motionTokens.duration.exit } }}
        transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.enter }}>
        {SORTS.map((item, index) => <li key={item.id} id={`${uid}-${item.id}`} role="option" aria-selected={item.id === value} data-active={index === active || undefined} className={styles.sortOption} onPointerMove={() => setActive(index)} onClick={() => pick(item.id)}>
          <span>{item.label}</span>{item.id === value ? <Check size={15} strokeWidth={1.75} aria-hidden="true" /> : null}
        </li>)}
      </motion.ul> : null}
    </AnimatePresence>
  </div>;
}

function PriceRange({ min, max, value, onChange, format }: { min: number; max: number; value: [number, number]; onChange: (value: [number, number]) => void; format: (value: number) => string }) {
  const [low, high] = value;
  const span = Math.max(1, max - min);
  const pct = (amount: number) => ((amount - min) / span) * 100;
  return <div className={styles.price}>
    <div className={styles.range}>
      <div className={styles.rangeTrack}><span className={styles.rangeFill} style={{ left: `${pct(low)}%`, right: `${100 - pct(high)}%` }} /></div>
      <input type="range" min={min} max={max} step={STEP} value={low} aria-label="Minimum price" aria-valuetext={format(low)} onChange={event => onChange([Math.min(Number(event.target.value), high - STEP), high])} />
      <input type="range" min={min} max={max} step={STEP} value={high} aria-label="Maximum price" aria-valuetext={format(high)} onChange={event => onChange([low, Math.max(Number(event.target.value), low + STEP)])} />
    </div>
    <div className={styles.priceValues}><Roll text={format(low)} /><Roll text={format(high)} /></div>
  </div>;
}

function Group({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <fieldset className={styles.group}>
    <legend className={styles.groupTitle}>{title}{action}</legend>
    {children}
  </fieldset>;
}

export function ProductListing({
  products = sampleProducts,
  colors = sampleColors,
  sizes = sampleSizes,
  defaultSort = "featured",
  onAddToCart,
  defaultCartCount = 0,
  currency = "USD",
  locale = "en-US",
  title = "Home goods",
  className,
}: ProductListingProps) {
  const uid = useId();
  const reduced = useReducedMotion() ?? false;
  const money = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }), [locale, currency]);
  const bounds = useMemo<[number, number]>(() => {
    const prices = products.map(product => product.price);
    if (!prices.length) return [0, 100];
    return [Math.floor(Math.min(...prices) / STEP) * STEP, Math.ceil(Math.max(...prices) / STEP) * STEP];
  }, [products]);

  const [sort, setSort] = useState<ListingSort>(defaultSort);
  const [price, setPrice] = useState<[number, number]>(bounds);
  const [pickedColors, setPickedColors] = useState<string[]>([]);
  const [pickedSizes, setPickedSizes] = useState<string[]>([]);
  const [inStock, setInStock] = useState(false);
  const [cart, setCart] = useState(defaultCartCount);
  const [picking, setPicking] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [sheet, setSheet] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(null), 1400);
    return () => window.clearTimeout(timer);
  }, [added]);
  useEffect(() => { if (sheet) sheetRef.current?.focus({ preventScroll: true }); }, [sheet]);

  const visible = useMemo(() => {
    const list = products.filter(product =>
      product.price >= price[0] && product.price <= price[1]
      && (!pickedColors.length || product.colors.some(color => pickedColors.includes(color)))
      && (!pickedSizes.length || product.sizes.some(size => pickedSizes.includes(size)))
      && (!inStock || product.inStock));
    const order: Record<ListingSort, (a: ListingProduct, b: ListingProduct) => number> = {
      featured: (a, b) => a.rank - b.rank,
      newest: (a, b) => b.added - a.added,
      "price-asc": (a, b) => a.price - b.price,
      "price-desc": (a, b) => b.price - a.price,
    };
    return [...list].sort(order[sort]);
  }, [products, price, pickedColors, pickedSizes, inStock, sort]);

  const activeCount = pickedColors.length + pickedSizes.length + (inStock ? 1 : 0) + (price[0] !== bounds[0] || price[1] !== bounds[1] ? 1 : 0);
  const clearAll = () => { setPrice(bounds); setPickedColors([]); setPickedSizes([]); setInStock(false); };
  const toggle = (list: string[], set: (next: string[]) => void, id: string) => set(list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  const closeSheet = useCallback(() => { setSheet(false); filterButton.current?.focus({ preventScroll: true }); }, []);

  const add = (product: ListingProduct, size: string) => {
    setCart(count => count + 1);
    setPicking(null);
    setAdded(product.id);
    setAnnouncement(`${product.name}${product.sizes.length > 1 ? `, size ${size},` : ""} added to bag`);
    onAddToCart?.(product, size);
  };
  const quickAdd = (product: ListingProduct) => {
    if (product.sizes.length === 1) add(product, product.sizes[0]);
    else setPicking(current => current === product.id ? null : product.id);
  };

  const filters = <div className={styles.filterBody}>
    <Group title="Price"><PriceRange min={bounds[0]} max={bounds[1]} value={price} onChange={setPrice} format={value => money.format(value)} /></Group>
    <Group title="Color">
      <div className={styles.swatches}>
        {colors.map(color => {
          const on = pickedColors.includes(color.id);
          return <button key={color.id} type="button" className={styles.swatch} aria-pressed={on} aria-label={color.name} title={color.name} onClick={() => toggle(pickedColors, setPickedColors, color.id)}>
            <span className={styles.swatchFill} style={{ background: color.swatch }} />
            <span className={styles.swatchCheck} data-on={on || undefined} data-light={isLight(color.swatch) || undefined}><Check size={14} strokeWidth={2.25} aria-hidden="true" /></span>
          </button>;
        })}
      </div>
    </Group>
    <Group title="Size">
      <div className={styles.sizes}>
        {sizes.map(size => <button key={size} type="button" className={styles.sizeChip} aria-pressed={pickedSizes.includes(size)} onClick={() => toggle(pickedSizes, setPickedSizes, size)}>{size}</button>)}
      </div>
    </Group>
    <label className={styles.switchRow}>
      <span>In stock only</span>
      <button type="button" role="switch" aria-checked={inStock} className={styles.switch} onClick={() => setInStock(value => !value)}><span className={styles.thumb} /></button>
    </label>
    <button type="button" className={styles.clearAll} onClick={clearAll} disabled={!activeCount}>Clear filters</button>
  </div>;

  return <div className={cx(styles.root, className)}>
    <div className={styles.frame}>
      <header className={styles.top}>
        <div className={styles.heading}><h2>{title}</h2><span className={styles.count}><Roll text={String(visible.length)} /> items</span></div>
        <div className={styles.tools}>
          <button ref={filterButton} type="button" className={styles.filterButton} onClick={() => setSheet(true)} aria-expanded={sheet}>
            <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />Filters{activeCount ? <span className={styles.badge}>{activeCount}</span> : null}
          </button>
          <SortMenu value={sort} onChange={setSort} />
          <span className={styles.bag} aria-label={`${cart} items in bag`} role="img">
            <motion.span key={cart} className={styles.bagIcon} initial={reduced || cart === defaultCartCount ? false : { scale: 1.18, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={motionTokens.spring.snappy}><ShoppingBag size={18} strokeWidth={1.75} aria-hidden="true" /></motion.span>
            <span className={styles.bagCount} aria-hidden="true"><Roll text={String(cart)} /></span>
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar} aria-label="Filters">{filters}</aside>

        <div className={styles.results}>
          {visible.length ? <LayoutGroup id={`${uid}-grid`}>
            <ul className={styles.grid}>
              <AnimatePresence mode="popLayout" initial={false}>
                {visible.map(product => {
                  const open = picking === product.id;
                  const done = added === product.id;
                  return <motion.li key={product.id} className={styles.card} layout={reduced ? false : "position"} data-active={open || done || undefined}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }} transition={reduced ? { duration: 0.12 } : motionTokens.spring.smooth}>
                    <div className={styles.media}>
                      <Image className={styles.image} src={product.image} alt={product.alt} fill sizes="(max-width: 640px) 50vw, 260px" />
                      {product.hoverImage ? <Image className={styles.hoverImage} src={product.hoverImage} alt="" fill sizes="(max-width: 640px) 50vw, 260px" /> : null}
                      <div className={styles.quick}>
                        <AnimatePresence mode="popLayout" initial={false}>
                          {done ? <motion.span key="done" className={styles.quickDone} initial={{ opacity: 0, filter: "blur(2px)", y: reduced ? 0 : 4 }} animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} exit={{ opacity: 0, filter: "blur(2px)" }} transition={{ duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }}>
                            <Check size={15} strokeWidth={1.75} aria-hidden="true" />Added
                          </motion.span> : open ? <motion.div key="sizes" className={styles.quickSizes} role="group" aria-label={`Choose a size for ${product.name}`} initial={{ opacity: 0, filter: "blur(2px)", y: reduced ? 0 : 4 }} animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} exit={{ opacity: 0, filter: "blur(2px)" }} transition={{ duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }}
                            onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPicking(null); } }}>
                            {product.sizes.map((size, index) => <button key={size} type="button" className={styles.quickSize} onClick={() => add(product, size)} ref={index === 0 ? (element: HTMLButtonElement | null) => element?.focus({ preventScroll: true }) : undefined}>{size}</button>)}
                            <button type="button" className={styles.quickClose} onClick={() => setPicking(null)} aria-label="Close sizes"><X size={14} strokeWidth={1.75} /></button>
                          </motion.div> : <motion.button key="add" type="button" className={styles.quickAdd} disabled={!product.inStock} onClick={() => quickAdd(product)} aria-label={product.inStock ? `Quick add ${product.name}` : `${product.name} is sold out`}
                            initial={{ opacity: 0, filter: "blur(2px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0, filter: "blur(2px)" }} transition={{ duration: motionTokens.duration.fast }}>
                            {product.inStock ? <><Plus size={15} strokeWidth={1.75} aria-hidden="true" />Quick add</> : "Sold out"}
                          </motion.button>}
                        </AnimatePresence>
                      </div>
                    </div>
                    <div className={styles.info}>
                      <h3 className={styles.name} title={product.name}>{product.name}</h3>
                      <p className={styles.detail}>{product.detail}</p>
                      <div className={styles.meta}>
                        <span className={styles.priceTag}>{product.compareAt ? <s className={styles.compare}>{money.format(product.compareAt)}</s> : null}<span data-sale={product.compareAt ? true : undefined}>{money.format(product.price)}</span></span>
                        <span className={styles.aside}>
                          {!product.inStock || product.badge ? <span className={styles.status}>{product.inStock ? product.badge : "Sold out"}</span> : null}
                          <span className={styles.dots} role="img" aria-label={`Colors: ${product.colors.map(id => colors.find(color => color.id === id)?.name ?? id).join(", ")}`}>
                            {product.colors.map(id => <span key={id} className={styles.dot} style={{ background: colors.find(color => color.id === id)?.swatch }} />)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </motion.li>;
                })}
              </AnimatePresence>
            </ul>
          </LayoutGroup> : <div className={styles.empty}>
            <p>No products match these filters</p>
            <button type="button" className={styles.clearAll} onClick={clearAll}>Clear filters</button>
          </div>}
        </div>
      </div>

      <AnimatePresence>
        {sheet ? <motion.div key="sheet" className={styles.sheetLayer} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }} transition={{ duration: motionTokens.duration.fast }}>
          <button type="button" className={styles.scrim} aria-label="Close filters" tabIndex={-1} onClick={closeSheet} />
          <motion.div ref={sheetRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Filters" tabIndex={-1}
            onKeyDown={event => { if (event.key === "Escape") closeSheet(); }}
            initial={{ x: reduced ? 0 : "-100%" }} animate={{ x: 0 }} exit={{ x: reduced ? 0 : "-100%", transition: { duration: motionTokens.duration.exit, ease: motionTokens.ease.exit } }} transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}>
            <div className={styles.sheetHead}><h3>Filters</h3><button type="button" className={styles.sheetClose} onClick={closeSheet} aria-label="Close filters"><X size={16} strokeWidth={1.75} /></button></div>
            {filters}
            <button type="button" className={styles.showResults} onClick={closeSheet}>Show {visible.length} {visible.length === 1 ? "item" : "items"}</button>
          </motion.div>
        </motion.div> : null}
      </AnimatePresence>
    </div>
    <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
  </div>;
}

function isLight(hex: string) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

export default ProductListing;
