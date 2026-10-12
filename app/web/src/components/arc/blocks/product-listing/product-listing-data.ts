import { photo } from "../../lib/media";

/** Sample catalog for the product listing block. Replace with products from your store. */

export interface ListingColor { id: string; name: string; swatch: string }

export interface ListingProduct {
  id: string;
  name: string;
  /** Short line under the name, such as the material. */
  detail: string;
  /** Price in whole currency units. */
  price: number;
  /** Previous price when the item is on sale. */
  compareAt?: number;
  image: string;
  /** Crossfades in on hover inside the same 4:5 box. */
  hoverImage?: string;
  alt: string;
  colors: string[];
  sizes: string[];
  inStock: boolean;
  /** Short status text in the meta row under the card, such as New. */
  badge?: string;
  /** Higher is newer, for the newest sort. */
  added: number;
  /** Lower is earlier, for the featured sort. */
  rank: number;
}

export const sampleColors: ListingColor[] = [
  { id: "oat", name: "Oat", swatch: "#d8cbb3" },
  { id: "clay", name: "Clay", swatch: "#b56a4c" },
  { id: "sage", name: "Sage", swatch: "#98a58a" },
  { id: "charcoal", name: "Charcoal", swatch: "#3b3a38" },
  { id: "chalk", name: "Chalk", swatch: "#f1eee7" },
];

export const sampleSizes = ["S", "M", "L"];

const src = (id: Parameters<typeof photo>[0]) => photo(id).src;

export const sampleProducts: ListingProduct[] = [
  { id: "p-lounge", name: "Woven lounge chair", detail: "Oak and paper cord", price: 340, image: src("lounge-chair"), hoverImage: src("living-room"), alt: photo("lounge-chair").alt, colors: ["oat", "charcoal"], sizes: ["M"], inStock: true, added: 9, rank: 1 },
  { id: "p-lamp", name: "Dome table lamp", detail: "Opal glass", price: 128, image: src("table-lamp"), hoverImage: src("home-office"), alt: photo("table-lamp").alt, colors: ["chalk", "oat"], sizes: ["S", "M"], inStock: true, added: 6, rank: 2 },
  { id: "p-throw", name: "Fringed linen throw", detail: "Stonewashed linen", price: 89, compareAt: 110, image: src("linen-throw"), hoverImage: src("bedroom"), alt: photo("linen-throw").alt, colors: ["oat", "sage", "clay"], sizes: ["S", "M", "L"], inStock: true, added: 4, rank: 3 },
  { id: "p-carafe", name: "Ribbed carafe set", detail: "Mouth blown glass", price: 64, image: src("glass-carafe"), hoverImage: src("sunroom"), alt: photo("glass-carafe").alt, colors: ["chalk"], sizes: ["M"], inStock: true, added: 8, rank: 4 },
  { id: "p-cups", name: "Speckled cups, pair", detail: "Glazed stoneware", price: 42, image: src("stoneware-cups"), hoverImage: src("stacked-bowls"), alt: photo("stoneware-cups").alt, colors: ["chalk", "clay"], sizes: ["S", "M"], inStock: false, added: 7, rank: 5 },
  { id: "p-bowls", name: "Stacking bowls", detail: "Glazed stoneware", price: 56, image: src("stacked-bowls"), hoverImage: src("stoneware-cups"), alt: photo("stacked-bowls").alt, colors: ["charcoal", "chalk"], sizes: ["S", "M", "L"], inStock: true, added: 3, rank: 6 },
  { id: "p-ceramic", name: "Arch ceramic lamp", detail: "Linen shade", price: 210, image: src("ceramic-lamp"), hoverImage: src("living-room"), alt: photo("ceramic-lamp").alt, colors: ["clay", "oat"], sizes: ["M", "L"], inStock: true, added: 10, rank: 7 },
  { id: "p-reader", name: "Reading armchair", detail: "Boucle and ash", price: 390, compareAt: 460, image: src("reading-chair"), hoverImage: src("home-office"), alt: photo("reading-chair").alt, colors: ["charcoal", "sage"], sizes: ["M", "L"], inStock: true, added: 2, rank: 8 },
];
