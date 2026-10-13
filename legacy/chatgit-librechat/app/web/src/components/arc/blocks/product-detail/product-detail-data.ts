import { photo } from "../../lib/media";
import type { PhotoId } from "../../lib/media";

/** Sample product for the product detail block. Replace with a product from your store. */

export interface DetailImage { src: string; alt: string }
export interface DetailFinish { id: string; name: string; swatch: string; images: DetailImage[] }
export interface DetailSize {
  id: string;
  name: string;
  /** Price in whole currency units. */
  price: number;
  /** Finish ids in which this size is out of stock. */
  soldOutIn?: string[];
  note?: string;
}
export interface DetailSection { id: string; title: string; body: string[] }

export interface DetailProduct {
  id: string;
  name: string;
  collection: string;
  summary: string;
  finishes: DetailFinish[];
  sizes: DetailSize[];
  rating: number;
  reviewCount: number;
  /** Review counts for 5, 4, 3, 2 and 1 stars. */
  distribution: [number, number, number, number, number];
  shipping: { title: string; text: string }[];
  sections: DetailSection[];
}

const img = (id: PhotoId): DetailImage => ({ src: photo(id).src, alt: photo(id).alt });

export const sampleProduct: DetailProduct = {
  id: "arch-lamp",
  name: "Arch ceramic lamp",
  collection: "Lighting",
  summary: "A hand thrown stoneware base under a washed linen shade. Warm, even light for a side table or a sideboard.",
  finishes: [
    { id: "clay", name: "Clay", swatch: "#b56a4c", images: [img("ceramic-lamp"), img("living-room"), img("home-office"), img("stacked-bowls")] },
    { id: "oat", name: "Oat", swatch: "#d8cbb3", images: [img("table-lamp"), img("sunroom"), img("bedroom"), img("linen-throw")] },
    { id: "charcoal", name: "Charcoal", swatch: "#3b3a38", images: [img("home-office"), img("ceramic-lamp"), img("reading-chair"), img("stoneware-cups")] },
  ],
  sizes: [
    { id: "small", name: "Small", price: 180, note: "38 cm tall" },
    { id: "large", name: "Large", price: 240, note: "52 cm tall", soldOutIn: ["charcoal"] },
  ],
  rating: 4.7,
  reviewCount: 128,
  distribution: [98, 20, 6, 3, 1],
  shipping: [
    { title: "Free delivery", text: "Arrives Sep 30 to Oct 2" },
    { title: "30 day returns", text: "Free pickup from your door" },
    { title: "Two year warranty", text: "Covers the wiring and the base" },
  ],
  sections: [
    { id: "details", title: "Details", body: ["Each base is thrown and glazed by hand in Porto, so the glaze pools a little differently on every lamp.", "Dimmable E27 socket, 2 m braided cable with an inline switch."] },
    { id: "dimensions", title: "Materials and dimensions", body: ["Base: glazed stoneware. Shade: stonewashed linen on a steel frame.", "Small: 38 cm tall, 26 cm shade. Large: 52 cm tall, 34 cm shade."] },
    { id: "care", title: "Care", body: ["Dust the base with a dry cloth. Spot clean the shade with a damp cloth and let it air dry.", "Use a bulb up to 40 W, or a warm 2700 K LED."] },
  ],
};
