'use client';

import { useEffect, useCallback } from 'react';
import { useChatStore } from '../store';
import type { MessageId } from '../types';

/**
 * Maps a DOM Selection inside a rendered-markdown container
 * back to character offsets in the raw Markdown source.
 *
 * Strategy: walk the raw markdown char-by-char, skipping syntax
 * characters, and align with the cumulative visible text extracted
 * from the DOM tree walker. This handles headings, bold, italic,
 * code, list markers, math delimiters, etc.
 */

function getTextNodesIn(node: Node): Text[] {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    textNodes.push(current as Text);
  }
  return textNodes;
}

function domOffsetToMarkdown(
  textNodes: Text[],
  targetNode: Node,
  targetOffset: number,
  rawMarkdown: string,
): number {
  let renderedBefore = '';
  for (const tn of textNodes) {
    if (tn === targetNode) {
      renderedBefore += tn.textContent?.slice(0, targetOffset) ?? '';
      break;
    }
    renderedBefore += tn.textContent ?? '';
  }

  let visibleCount = 0;
  let i = 0;
  const target = renderedBefore.length;

  while (i < rawMarkdown.length && visibleCount < target) {
    const ch = rawMarkdown[i];

    if (isLineStart(rawMarkdown, i) && ch === '#') {
      while (i < rawMarkdown.length && rawMarkdown[i] === '#') i++;
      if (rawMarkdown[i] === ' ') i++;
      continue;
    }

    if (ch === '*' || ch === '_') {
      let run = 0;
      const mark = ch;
      while (i + run < rawMarkdown.length && rawMarkdown[i + run] === mark)
        run++;
      if (run <= 3) {
        i += run;
        continue;
      }
    }

    if (ch === '`') {
      i++;
      continue;
    }

    if (ch === '$') {
      i++;
      continue;
    }

    if (ch === '\\' && i + 1 < rawMarkdown.length) {
      i++;
      visibleCount++;
      i++;
      continue;
    }

    if (
      isLineStart(rawMarkdown, i) &&
      ch === '-' &&
      rawMarkdown[i + 1] === ' '
    ) {
      i += 2;
      continue;
    }

    if (isLineStart(rawMarkdown, i) && /\d/.test(ch)) {
      let j = i;
      while (j < rawMarkdown.length && /\d/.test(rawMarkdown[j])) j++;
      if (rawMarkdown[j] === '.' && rawMarkdown[j + 1] === ' ') {
        i = j + 2;
        continue;
      }
    }

    visibleCount++;
    i++;
  }

  return i;
}

function isLineStart(s: string, pos: number): boolean {
  return pos === 0 || s[pos - 1] === '\n';
}

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
      const selectedText = selection.toString().trim();
      if (!selectedText) return;

      // Guard: both ends of the range must be inside the same message
      const startContainer = findMessageContainer(range.startContainer);
      const endContainer = findMessageContainer(range.endContainer);
      if (!startContainer || startContainer !== endContainer) return;

      const container = startContainer;
      const messageId = container.getAttribute(
        'data-message-id',
      ) as MessageId | null;
      const rawMarkdown = container.getAttribute('data-raw-md') ?? '';
      if (!messageId || !rawMarkdown) return;

      if (container.getAttribute('data-role') !== 'assistant') return;

      const textNodes = getTextNodesIn(container);

      const startOffset = domOffsetToMarkdown(
        textNodes,
        range.startContainer,
        range.startOffset,
        rawMarkdown,
      );
      const endOffset = domOffsetToMarkdown(
        textNodes,
        range.endContainer,
        range.endOffset,
        rawMarkdown,
      );

      if (startOffset >= endOffset) return;

      const rect = range.getBoundingClientRect();

      setPendingSelection({
        messageId,
        slice: { startOffset, endOffset, selectedText },
        rect,
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
