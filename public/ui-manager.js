// UI management module
// Handles status updates, URL display, session selector, and frame rendering

import { sessions, getCurrentSessionId } from './session-manager.js';

// DOM elements
let statusEl, currentUrlEl, sessionSelector, forkBtn, newSessionBtn;
let canvas, ctx, loadingEl;

// Browser dimensions
export let browserWidth = 2880;
export let browserHeight = 1800;
export let currentTier = 'primary';

// View management - maps sessionId to render targets
const activeViews = new Map(); // sessionId -> { canvas, ctx, render }

// Initialize UI elements
export function initializeUI() {
  statusEl = document.getElementById('status');
  currentUrlEl = document.getElementById('currentUrl');
  sessionSelector = document.getElementById('sessionSelector');
  forkBtn = document.getElementById('forkBtn');
  newSessionBtn = document.getElementById('newSessionBtn');
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  loadingEl = document.getElementById('loading');
}

// Update status display
export function setStatus(message, className) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = `status ${className}`;
  }
}

// Update URL display
export function updateUrlDisplay(url) {
  if (!currentUrlEl) return;

  if (url) {
    currentUrlEl.textContent = url;
    currentUrlEl.className = 'url-value';
  } else {
    currentUrlEl.textContent = 'No page loaded';
    currentUrlEl.className = 'url-value empty';
  }
}

// Register the main canvas as a view for a session
export function registerMainView(sessionId) {
  if (!sessionId) return;

  // Clear previous registrations for main canvas
  activeViews.clear();

  // Register this session to the main canvas
  activeViews.set(sessionId, {
    canvas: canvas,
    ctx: ctx,
    render: (base64Data, metadata) => {
      if (loadingEl) loadingEl.style.display = 'none';

      // Update browser dimensions if changed
      if (metadata) {
        browserWidth = metadata.width || browserWidth;
        browserHeight = metadata.height || browserHeight;
      }

      // Create image from base64
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = `data:image/jpeg;base64,${base64Data}`;
    }
  });
}

// Generic frame dispatcher - routes frames to appropriate views
export function dispatchFrame(sessionId, base64Data, metadata) {
  const view = activeViews.get(sessionId);
  if (view && view.render) {
    view.render(base64Data, metadata);
  }
}

// Update session selector dropdown
export function updateSessionSelector(ws) {
  if (!sessionSelector) return;

  const currentSessionId = getCurrentSessionId();

  // Clear existing options
  sessionSelector.innerHTML = '';

  if (sessions.size === 0) {
    const option = document.createElement('option');
    option.textContent = 'No sessions';
    sessionSelector.appendChild(option);
    sessionSelector.disabled = true;
    if (forkBtn) forkBtn.disabled = true;
  } else {
    sessionSelector.disabled = false;
    if (forkBtn) forkBtn.disabled = !currentSessionId;

    // Add option for each session
    for (const [sessionId, session] of sessions) {
      const option = document.createElement('option');
      option.value = sessionId;
      const isActive = sessionId === currentSessionId;
      // Add visual indicator for active session
      option.textContent = `${isActive ? '▶ ' : ''}Session ${sessionId.substring(0, 8)}${session.url ? ` - ${session.url}` : ''}`;
      option.selected = isActive;
      sessionSelector.appendChild(option);
    }
  }

  // New session button is always enabled if WebSocket is connected
  if (newSessionBtn) {
    newSessionBtn.disabled = !ws || ws.readyState !== WebSocket.OPEN;
  }

  console.log(`Session selector updated. Active session: ${currentSessionId?.substring(0, 8) || 'none'}`);
}

// Update browser dimensions and tier
export function updateBrowserState(width, height, tier) {
  browserWidth = width;
  browserHeight = height;
  currentTier = tier;
}

// Remove view registration for a session
export function unregisterView(sessionId) {
  activeViews.delete(sessionId);
}

// Get UI element references for event listeners
export function getUIElements() {
  return {
    canvas,
    sessionSelector,
    forkBtn,
    newSessionBtn
  };
}
