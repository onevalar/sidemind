/**
 * rehype-source-marks.ts
 *
 * A rehype plugin that makes the rendered DOM "source aware":
 *
 *  1. Every text run that came from the Markdown source is wrapped in
 *     <span data-o="START"> (START = offset of its first char in the raw
 *     Markdown). If the rendered text doesn't match the source 1:1 (escapes,
 *     entities, inline-code backticks …) a per-char table is stored in
 *     data-om. The selection hook uses these to map a DOM selection back to
 *     exact Markdown offsets — no guessing.
 *
 *  2. Math nodes are wrapped in an "atomic" element
 *     (data-atomic, data-o, data-oe) because a formula can only be
 *     selected as a whole.
 *
 *  3. Anchor highlights are applied here, on the DOM tree, by wrapping the
 *     covered text runs in <mark data-anchor-id>. Highlights therefore work
 *     across paragraphs/list items, can overlap, and never touch the
 *     Markdown source (so they can't break its syntax).
 *
 * Must run BEFORE rehype-katex (it wraps the raw math nodes katex consumes).
 */

import type { Element, ElementContent, Root, Text } from 'hast';

export interface AnchorRange {
  id: string;
  start: number;
  end: number;
  /** Highlight color (used to tint display formulas, which can't sit inside an inline <mark>) */
  color?: string;
}

export interface SourceMarksOptions {
  anchors: AnchorRange[];
}

function isMathElement(node: Element): boolean {
  const cls = node.properties?.className;
  return Array.isArray(cls) && cls.includes('language-math');
}

function el(
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[],
): Element {
  return { type: 'element', tagName, properties, children };
}

/** Source offset of each char of `value`, or null when it's a contiguous run. */
function alignToSource(
  source: string,
  value: string,
  start: number,
  end: number,
): { base: number; map: number[] | null } {
  const raw = source.slice(start, end);
  if (raw === value) return { base: start, map: null };

  const idx = raw.indexOf(value);
  if (idx !== -1) return { base: start + idx, map: null };

  // Greedy alignment: skip source chars (escapes, backticks, entity text…)
  const map: number[] = [];
  let p = 0;
  for (let i = 0; i < value.length; i++) {
    const q = raw.indexOf(value[i], p);
    if (q === -1) {
      map.push(start + Math.min(p, Math.max(raw.length - 1, 0)));
    } else {
      map.push(start + q);
      p = q + 1;
    }
  }
  return { base: map[0] ?? start, map };
}

export function rehypeSourceMarks(options: SourceMarksOptions) {
  const anchors = options?.anchors ?? [];

  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '');

    const coveringAt = (off: number) =>
      anchors.filter((a) => a.start <= off && off < a.end);

    const wrapInMarks = (inner: Element, ids: string[]): Element =>
      ids.reduceRight<Element>(
        (acc, id) => el('mark', { dataAnchorId: id }, [acc]),
        inner,
      );

    function processText(node: Text): ElementContent[] {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null || node.value.length === 0) return [node];

      const { base, map } = alignToSource(source, node.value, start, end);
      const offAt = (i: number) => (map ? map[i] : base + i);
      const len = node.value.length;

      // Fast path: no anchor touches this text run
      const first = offAt(0);
      const last = offAt(len - 1);
      const touched = anchors.some((a) => a.start <= last && a.end > first);

      const cuts = [0];
      let prevKey = '';
      if (touched) {
        for (let i = 0; i < len; i++) {
          const key = coveringAt(offAt(i))
            .map((a) => a.id)
            .join('|');
          if (i > 0 && key !== prevKey) cuts.push(i);
          prevKey = key;
        }
      }
      cuts.push(len);

      const out: ElementContent[] = [];
      for (let c = 0; c < cuts.length - 1; c++) {
        const i = cuts[c];
        const j = cuts[c + 1];
        const props: Element['properties'] = { dataO: offAt(i) };
        if (map) props.dataOm = map.slice(i, j).join(',');

        const span = el('span', props, [
          { type: 'text', value: node.value.slice(i, j) },
        ]);
        const ids = touched ? coveringAt(offAt(i)).map((a) => a.id) : [];
        out.push(ids.length ? wrapInMarks(span, ids) : span);
      }
      return out;
    }

    function wrapAtomic(node: Element, block: boolean): Element {
      const pos = node.position ?? (node.children[0] as Element | undefined)?.position;
      const start = pos?.start.offset;
      const end = pos?.end.offset;
      if (start == null || end == null) return node;

      const covering = anchors.filter((a) => a.start < end && a.end > start);
      const props: Element['properties'] = {
        dataAtomic: '',
        dataO: start,
        dataOe: end,
      };

      if (block) {
        // A block formula can't live inside an inline <mark>: tint its wrapper
        const tint = covering.find((a) => a.color)?.color;
        if (tint) {
          props.style = `background:${tint}25;border-bottom:2px solid ${tint};border-radius:2px`;
        }
        return el('div', props, [node]);
      }

      const ids = covering.map((a) => a.id);
      return el('span', props, [ids.length ? wrapInMarks(node, ids) : node]);
    }

    function walk(parent: Root | Element) {
      const next: ElementContent[] = [];
      for (const child of parent.children as ElementContent[]) {
        if (child.type === 'text') {
          next.push(...processText(child));
          continue;
        }
        if (child.type === 'element') {
          // Display math: <pre><code class="language-math math-display">
          if (
            child.tagName === 'pre' &&
            child.children.length === 1 &&
            child.children[0].type === 'element' &&
            isMathElement(child.children[0])
          ) {
            next.push(wrapAtomic(child, true));
            continue;
          }
          // Inline math: <code class="language-math math-inline">
          if (child.tagName === 'code' && isMathElement(child)) {
            next.push(wrapAtomic(child, false));
            continue;
          }
          walk(child);
        }
        next.push(child);
      }
      parent.children = next as typeof parent.children;
    }

    walk(tree);
  };
}
