'use client';

import { useEffect, useCallback } from 'react';
import { useChatStore } from '../store';
import type { MessageId } from '../types';

/**
 * Maps a DOM Selection inside a rendered-markdown container back to
 * character offsets in the raw Markdown source.
 *
 * The renderer (see lib/rehype-source-marks.ts) tags every text run with
 * its source offset (`data-o`, plus a per-char table `data-om` when the
 * rendered text differs from the source) and every formula with its full
 * source range (`data-atomic`, `data-o`, `data-oe`). So the mapping here is a
 * lookup, not a guess — it works across headings, lists, tables, code,
 * bold/italic, links and math.
 */

type Boundary = 'start' | 'end';

function findMessageContainer(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.hasAttribute('data-message-id')
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function elementOf(node: Node): HTMLElement | null {
  return node instanceof HTMLElement ? node : node.parentElement;
}

/** Source offset of char index `k` (0..len) inside a `[data-o]` span */
function offsetInSpan(span: HTMLElement, k: number, kind: Boundary): number {
  const base = Number(span.dataset.o);
  const len = span.textContent?.length ?? 0;
  const om = span.dataset.om;

  if (!om) {
    return base + Math.max(0, Math.min(k, len));
  }

  const table = om.split(',').map(Number);
  if (kind === 'start') {
    return k >= table.length ? table[table.length - 1] + 1 : table[Math.max(k, 0)];
  }
  return k <= 0 ? table[0] : table[Math.min(k, table.length) - 1] + 1;
}

/** Start/end source offset of a whole leaf (text span or formula) */
function leafRange(leaf: HTMLElement): [number, number] {
  if (leaf.hasAttribute('data-atomic')) {
    return [Number(leaf.dataset.o), Number(leaf.dataset.oe)];
  }
  const len = leaf.textContent?.length ?? 0;
  return [offsetInSpan(leaf, 0, 'start'), offsetInSpan(leaf, len, 'end')];
}

function resolveBoundary(
  container: HTMLElement,
  range: Range,
  node: Node,
  offset: number,
  kind: Boundary,
): number | null {
  const el = elementOf(node);

  // Inside a formula → snap to the whole formula
  const atomic = el?.closest<HTMLElement>('[data-atomic]');
  if (atomic && container.contains(atomic)) {
    return Number(kind === 'start' ? atomic.dataset.o : atomic.dataset.oe);
  }

  // Inside a text run → exact char offset
  if (node.nodeType === Node.TEXT_NODE) {
    const span = el?.closest<HTMLElement>('[data-o]');
    if (span && container.contains(span)) {
      return offsetInSpan(span, offset, kind);
    }
  }

  // Boundary sits between elements (e.g. triple-click, drag past a block):
  // use the first / last annotated leaf that the range actually covers.
  const leaves = Array.from(
    container.querySelectorAll<HTMLElement>('[data-o]'),
  ).filter(
    // skip text spans nested in formulas
    (leaf) => leaf.hasAttribute('data-atomic') || !leaf.closest('[data-atomic]'),
  );
  const covered = leaves.filter((leaf) => range.intersectsNode(leaf));
  if (covered.length === 0) return null;

  return kind === 'start'
    ? leafRange(covered[0])[0]
    : leafRange(covered[covered.length - 1])[1];
}

/** Human-readable text of a range (formulas as their TeX source) */
function displayTextOf(range: Range): string {
  const tmp = document.createElement('div');
  tmp.appendChild(range.cloneContents());

  // A rendered formula is a visual + MathML twin; show its TeX source instead
  tmp.querySelectorAll('.katex').forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]');
    k.replaceWith(document.createTextNode(tex?.textContent ?? ''));
  });

  tmp
    .querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,tr,td,th,pre,blockquote,div,br')
    .forEach((n) => n.append(n.matches('td,th') ? ' ' : '\n'));
  return (tmp.textContent ?? '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function useTextSelection() {
  const setPendingSelection = useChatStore((s) => s.setPendingSelection);

  const dismiss = useCallback(() => {
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [setPendingSelection]);

  const handleMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);

      // Guard: both ends of the range must be inside the same message
      const startContainer = findMessageContainer(range.startContainer);
      const endContainer = findMessageContainer(range.endContainer);
      if (!startContainer || startContainer !== endContainer) return;

      const container = startContainer;
      if (container.getAttribute('data-role') !== 'assistant') return;

      const messageId = container.getAttribute(
        'data-message-id',
      ) as MessageId | null;
      const message = messageId
        ? useChatStore.getState().messages[messageId]
        : null;
      if (!messageId || !message) return;

      let startOffset = resolveBoundary(
        container,
        range,
        range.startContainer,
        range.startOffset,
        'start',
      );
      let endOffset = resolveBoundary(
        container,
        range,
        range.endContainer,
        range.endOffset,
        'end',
      );
      if (startOffset == null || endOffset == null) return;

      // Trim surrounding whitespace in the source slice
      const src = message.content;
      endOffset = Math.min(endOffset, src.length);
      while (startOffset < endOffset && /\s/.test(src[startOffset])) startOffset++;
      while (endOffset > startOffset && /\s/.test(src[endOffset - 1])) endOffset--;
      if (startOffset >= endOffset) return;

      const selectedText = displayTextOf(range);
      if (!selectedText) return;

      setPendingSelection({
        messageId,
        slice: { startOffset, endOffset, selectedText },
        rect: range.getBoundingClientRect(),
      });
    });
  }, [setPendingSelection]);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-popover]')) return;
      setPendingSelection(null);
    },
    [setPendingSelection],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    },
    [dismiss],
  );

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleMouseUp, handleMouseDown, handleKeyDown]);
}
