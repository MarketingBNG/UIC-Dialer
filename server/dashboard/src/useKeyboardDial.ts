import { useEffect } from "react";

/** True when the user is typing somewhere, so a digit belongs to that field and not to us. */
function typingInField(el: Element | null) {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return (el as HTMLElement).isContentEditable;
}

/**
 * Keyboard dialing: typing a digit or + on a page (nothing focused for typing, no dialog open)
 * opens quick search with that character, so the rep can type the number and press Enter to call.
 */
export function useKeyboardDial(start: (firstChar: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!/^[\d+]$/.test(e.key)) return;
      if (typingInField(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      start(e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start]);
}
