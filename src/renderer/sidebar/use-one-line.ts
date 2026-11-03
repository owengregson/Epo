import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * Whether `text` fits its element on one line, measured after layout and again whenever the text changes:
 * the element first renders the one-line form, and a line that overflows switches to the fallback before
 * the frame paints.
 */
export function useOneLine<E extends HTMLElement>(text: string): [RefObject<E>, boolean] {
  const el = useRef<E>(null);
  const [one, setOne] = useState(true);
  useLayoutEffect(() => setOne(true), [text]);
  useLayoutEffect(() => {
    const node = el.current;
    if (one && node !== null && node.scrollWidth > node.clientWidth) setOne(false);
  }, [text, one]);
  return [el, one];
}
