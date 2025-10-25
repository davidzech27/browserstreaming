// Input handling module
// Handles keyboard, mouse, and other input events

import { getCurrentSessionId, recordWithSampling, handleNavigation } from './session-manager.js';
import { browserWidth, browserHeight, updateUrlDisplay } from './ui-manager.js';

// Canvas focus state
let canvasFocused = false;

// Get scaled coordinates (canvas -> browser viewport)
function getScaledCoordinates(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = browserWidth / rect.width;
  const scaleY = browserHeight / rect.height;

  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;

  return { x, y };
}

// Convert modifiers to CDP bit field: Alt=1, Ctrl=2, Meta=4, Shift=8
function getModifiers(event) {
  return (event.altKey ? 1 : 0) |
         (event.ctrlKey ? 2 : 0) |
         (event.metaKey ? 4 : 0) |
         (event.shiftKey ? 8 : 0);
}

// Map button number to CDP button name
function getButtonName(button) {
  return ['left', 'middle', 'right', 'back', 'forward'][button] || 'left';
}

function getActiveButton(buttons) {
  if (!buttons) {
    return 'none';
  }
  if (buttons & 1) {
    return 'left';
  }
  if (buttons & 4) {
    return 'middle';
  }
  if (buttons & 2) {
    return 'right';
  }
  return 'none';
}

// Get current scroll position from server
async function getScrollPosition(sessionId, sendFn) {
  return new Promise((resolve) => {
    const messageHandler = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'scrollPosition' && data.sessionId === sessionId) {
        window.removeEventListener('message', messageHandler);
        resolve({ x: data.scrollX, y: data.scrollY });
      }
    };

    // Listen for scroll position response via WebSocket (we'll use a global handler)
    if (!window.scrollPositionCallbacks) {
      window.scrollPositionCallbacks = new Map();
    }

    window.scrollPositionCallbacks.set(sessionId, resolve);
    sendFn({ type: 'getScrollPosition', sessionId });

    // Timeout after 100ms, return 0,0
    setTimeout(() => {
      if (window.scrollPositionCallbacks.has(sessionId)) {
        window.scrollPositionCallbacks.delete(sessionId);
        resolve({ x: 0, y: 0 });
      }
    }, 100);
  });
}

// Send and record interaction
export function sendAndRecord(data, sendFn) {
  // Verify we have an active session
  if (!data.sessionId) {
    console.error('sendAndRecord called without sessionId:', data);
    return;
  }

  // Log important interactions for debugging
  if (data.type === 'navigate' || data.type === 'mousePressed' || data.type === 'keyDown') {
    console.log(`→ Sending ${data.type} to session ${data.sessionId.substring(0, 8)}`);
  }

  // Don't record session management or quality tier changes
  const recordableTypes = ['navigate', 'mousePressed', 'mouseReleased', 'mouseMoved',
                           'mouseWheel', 'keyDown', 'keyUp', 'paste'];

  if (recordableTypes.includes(data.type)) {
    // Special handling for navigate - clear history on URL change
    if (data.type === 'navigate') {
      handleNavigation(data.url, updateUrlDisplay);
      recordWithSampling(data);
    } else {
      recordWithSampling(data);
    }
  }

  sendFn(data);
}

// Send and record interaction with scroll position (for important interactions)
export async function sendAndRecordWithScroll(data, sendFn) {
  // Verify we have an active session
  if (!data.sessionId) {
    console.error('sendAndRecordWithScroll called without sessionId:', data);
    return;
  }

  // Get current scroll position
  const scrollPos = await getScrollPosition(data.sessionId, sendFn);

  // Add scroll position to the data
  data.scrollX = scrollPos.x;
  data.scrollY = scrollPos.y;

  // Log important interactions for debugging
  if (data.type === 'navigate' || data.type === 'mousePressed' || data.type === 'keyDown') {
    console.log(`→ Sending ${data.type} to session ${data.sessionId.substring(0, 8)} at scroll (${scrollPos.x}, ${scrollPos.y})`);
  }

  // Don't record session management or quality tier changes
  const recordableTypes = ['navigate', 'mousePressed', 'mouseReleased', 'mouseMoved',
                           'mouseWheel', 'keyDown', 'keyUp', 'paste'];

  if (recordableTypes.includes(data.type)) {
    // Special handling for navigate - clear history on URL change
    if (data.type === 'navigate') {
      handleNavigation(data.url, updateUrlDisplay);
      recordWithSampling(data);
    } else {
      recordWithSampling(data);
    }
  }

  sendFn(data);
}

// Setup mouse event handlers
export function setupMouseHandlers(canvas, sendFn) {
  canvas.addEventListener('mousedown', async (e) => {
    const currentSessionId = getCurrentSessionId();
    if (!currentSessionId) {
      console.warn('No active session - ignoring mouse input');
      return;
    }

    const { x, y } = getScaledCoordinates(canvas, e);
    await sendAndRecordWithScroll({
      type: 'mousePressed',
      sessionId: currentSessionId,
      x,
      y,
      button: getButtonName(e.button),
      clickCount: e.detail,
      modifiers: getModifiers(e),
    }, sendFn);

    // Focus canvas for keyboard input
    canvasFocused = true;
    canvas.style.outline = '2px solid #0066ff';
  });

  canvas.addEventListener('mouseup', async (e) => {
    const currentSessionId = getCurrentSessionId();
    if (!currentSessionId) return;

    const { x, y } = getScaledCoordinates(canvas, e);
    await sendAndRecordWithScroll({
      type: 'mouseReleased',
      sessionId: currentSessionId,
      x,
      y,
      button: getButtonName(e.button),
      clickCount: e.detail,
      modifiers: getModifiers(e),
    }, sendFn);
  });

  canvas.addEventListener('mousemove', (e) => {
    const currentSessionId = getCurrentSessionId();
    if (!currentSessionId) return;

    const { x, y } = getScaledCoordinates(canvas, e);
    sendAndRecord({
      type: 'mouseMoved',
      sessionId: currentSessionId,
      x,
      y,
      button: getActiveButton(e.buttons),
      modifiers: getModifiers(e),
    }, sendFn);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  canvas.addEventListener('wheel', (e) => {
    const currentSessionId = getCurrentSessionId();
    if (!currentSessionId) return;

    e.preventDefault();
    const { x, y } = getScaledCoordinates(canvas, e);

    // Send wheel event in real-time but DON'T record it
    // Scroll position will be captured before the next interaction
    sendFn({
      type: 'mouseWheel',
      sessionId: currentSessionId,
      x,
      y,
      deltaX: e.deltaX * 0.1,
      deltaY: e.deltaY * 0.1,
      modifiers: getModifiers(e),
    });
  }, { passive: false });
}

// Setup keyboard event handlers
export function setupKeyboardHandlers(canvas, sendFn) {
  document.addEventListener('click', (e) => {
    if (!canvas.contains(e.target)) {
      canvasFocused = false;
      canvas.style.outline = 'none';
    }
  });

  document.addEventListener('keydown', (e) => {
    const currentSessionId = getCurrentSessionId();
    if (canvasFocused && currentSessionId && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
      e.preventDefault();

      // Determine if this key should have text
      let text = undefined;
      if (e.key.length === 1) {
        text = e.key;
      } else if (e.key === 'Enter') {
        text = '\r';
      } else if (e.key === 'Tab') {
        text = '\t';
      }

      sendAndRecord({
        type: 'keyDown',
        sessionId: currentSessionId,
        key: e.key,
        code: e.code,
        text: text,
        modifiers: getModifiers(e),
      }, sendFn);
    }
  });

  document.addEventListener('keyup', (e) => {
    const currentSessionId = getCurrentSessionId();
    if (canvasFocused && currentSessionId && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      sendAndRecord({
        type: 'keyUp',
        sessionId: currentSessionId,
        key: e.key,
        code: e.code,
        modifiers: getModifiers(e),
      }, sendFn);
    }
  });

  document.addEventListener('paste', async (e) => {
    const currentSessionId = getCurrentSessionId();
    if (canvasFocused && currentSessionId) {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        sendAndRecord({ type: 'paste', sessionId: currentSessionId, text }, sendFn);
      }
    }
  });
}

// Setup navigation handlers
export function setupNavigationHandlers(urlInput, navigateBtn, sendFn, setStatusFn) {
  navigateBtn.addEventListener('click', () => {
    const currentSessionId = getCurrentSessionId();
    const url = urlInput.value.trim();
    if (!url) {
      console.warn('No URL entered');
      return;
    }
    if (!currentSessionId) {
      console.warn('No active session - cannot navigate');
      setStatusFn('No active session', 'error');
      return;
    }
    console.log(`Navigating active session ${currentSessionId.substring(0, 8)} to: ${url}`);
    sendAndRecord({ type: 'navigate', sessionId: currentSessionId, url }, sendFn);
  });

  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      navigateBtn.click();
    }
  });
}
