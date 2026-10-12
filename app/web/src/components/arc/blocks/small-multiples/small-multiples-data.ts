export interface SmallMultiplesSeries {
  /** Stable id, used as the React key and in callbacks. */
  id: string;
  /** Panel heading, such as a region or product name. */
  name: string;
  /** One value per period, in the same order as the periods. */
  values: number[];
}

export type SmallMultiplesSort = "latest" | "growth" | "name";
export type SmallMultiplesScale = "shared" | "independent";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Month labels built from a start month without Date, so server and client always agree. */
function months(startYear: number, startMonth: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const month = (startMonth + index) % 12;
    const year = startYear + Math.floor((startMonth + index) / 12);
    return { short: `${MONTHS[month]} ${year}`, long: `${LONG[month]} ${year}` };
  });
}

/** Seeded generator, so the sample data is identical on every render and every machine. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT = 24;
/** October 2024 to September 2026. */
export const smallMultiplesPeriods = months(2024, 9, COUNT);

/** Base monthly revenue in USD thousands, monthly growth, seasonal swing and noise for each region. */
const SHAPES: { id: string; name: string; base: number; growth: number; season: number; noise: number; seed: number }[] = [
  { id: "na", name: "North America", base: 1180, growth: .016, season: .06, noise: .018, seed: 11 },
  { id: "uk", name: "United Kingdom", base: 540, growth: .009, season: .05, noise: .02, seed: 23 },
  { id: "de", name: "Germany", base: 612, growth: .0008, season: .04, noise: .012, seed: 37 },
  { id: "fr", name: "France", base: 384, growth: -.0006, season: .05, noise: .012, seed: 41 },
  { id: "nordics", name: "Nordics", base: 236, growth: .024, season: .07, noise: .022, seed: 53 },
  { id: "jp", name: "Japan", base: 428, growth: -.011, season: .03, noise: .016, seed: 67 },
  { id: "au", name: "Australia", base: 262, growth: .0012, season: .04, noise: .014, seed: 79 },
  { id: "br", name: "Brazil", base: 148, growth: .038, season: .05, noise: .03, seed: 97 },
];

/** Net revenue by region, monthly, in USD thousands. December peaks and a quiet summer run through every region. */
export const smallMultiplesSeries: SmallMultiplesSeries[] = SHAPES.map(shape => {
  const random = mulberry32(shape.seed);
  return {
    id: shape.id,
    name: shape.name,
    values: Array.from({ length: COUNT }, (_, index) => {
      const month = (9 + index) % 12;
      const seasonal = 1 + shape.season * Math.cos(((month - 11) / 12) * Math.PI * 2);
      const noise = 1 + (random() * 2 - 1) * shape.noise;
      return Math.round(shape.base * Math.pow(1 + shape.growth, index) * seasonal * noise);
    }),
  };
});

export const smallMultiplesTitle = "Revenue by region";
export const smallMultiplesDescription = "Monthly net revenue, October 2024 to September 2026";
