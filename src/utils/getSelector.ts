/**
 * Generate a unique CSS selector for an element
 * This can be used both in browser context and Node.js context
 */

/**
 * Browser-side implementation (to be injected into pages)
 * Returns a CSS selector string that uniquely identifies the element
 */
export function getSelectorScript(): string {
  return `
window.getSelector = function(el) {
  if (!el) return '';

  // If element has an ID, use it
  if (el.id) {
    return '#' + CSS.escape(el.id);
  }

  // Build path from element to root
  const path = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();

    // Add classes if present
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\\s+/).filter(c => c);
      if (classes.length > 0) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
    }

    // If this selector is unique among siblings, we can stop here
    if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children);
      const matchingSiblings = siblings.filter(sib => {
        if (sib.tagName !== current.tagName) return false;
        if (current.className && typeof current.className === 'string') {
          return sib.className === current.className;
        }
        return true;
      });

      if (matchingSiblings.length > 1) {
        // Add nth-child for disambiguation
        const index = siblings.indexOf(current) + 1;
        selector += \`:nth-child(\${index})\`;
      }
    }

    path.unshift(selector);

    // If we've reached body or have an ID, we can stop
    if (current.tagName.toLowerCase() === 'body' || current.id) {
      break;
    }

    current = current.parentElement;
  }

  return path.join(' > ');
};
  `.trim();
}

/**
 * Get selector for element at coordinates
 * This should be called in page.evaluate() context
 */
export function getSelectorAtCoordinatesScript(): string {
  return `
${getSelectorScript()}

window.getSelectorAtCoordinates = function(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;

  return {
    selector: window.getSelector(element),
    tagName: element.tagName.toLowerCase(),
    textContent: element.textContent?.substring(0, 100) || '',
    id: element.id || '',
    className: element.className || '',
  };
};
  `.trim();
}

/**
 * Node.js helper to inject getSelector into page context
 */
export async function injectGetSelector(page: any): Promise<void> {
  await page.addInitScript(`
    ${getSelectorScript()}
  `);
}
