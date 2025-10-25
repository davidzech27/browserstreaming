// Main client entry point
// Handles WebSocket connection and coordinates all modules

import {
  sessions,
  getCurrentSessionId,
  setCurrentSessionId,
  setCurrentUrl,
  getInteractionHistory,
  setInteractionHistory,
  resetMouseMoveCounter,
  createNewSession,
  forkSession,
  switchToSession,
  replayInteractions,
} from './session-manager.js';

import {
  initializeUI,
  setStatus,
  updateUrlDisplay,
  updateSessionSelector,
  registerMainView,
  dispatchFrame,
  unregisterView,
  updateBrowserState,
  getUIElements,
  getBrowserWidth,
  getBrowserHeight,
  getCurrentTier,
} from './ui-manager.js';

import {
  sendAndRecord,
  setupMouseHandlers,
  setupKeyboardHandlers,
  setupNavigationHandlers,
} from './input-handler.js';

// DOM elements
const urlInput = document.getElementById('urlInput');
const navigateBtn = document.getElementById('navigateBtn');

// WebSocket connection
let ws = null;

// Quality tier tracking
const TIER_CONFIGS = {
  background: { width: 2880, height: 1800 },
  secondary: { width: 2880, height: 1800 },
  primary: { width: 2880, height: 1800 },
};

// Connect to WebSocket
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('Connected - Creating session...', 'connected');
    send({ type: 'createSession', tier: 'primary' });
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'connected':
        console.log('Connection established:', data.connectionId);
        break;

      case 'sessionCreated': {
        const sessionId = data.sessionId;

        // Create session object
        const sessionObj = {
          id: sessionId,
          url: '',
          interactionHistory: [],
          tier: data.tier,
          width: data.width,
          height: data.height
        };

        sessions.set(sessionId, sessionObj);

        // Check if this is a fork
        if (window.pendingFork) {
          console.log('Processing pending fork...');
          const fork = window.pendingFork;
          window.pendingFork = null;

          // Update session with forked data
          sessionObj.url = fork.url;
          sessionObj.interactionHistory = [...fork.interactions];

          // Switch to the forked session immediately so user can see the replay
          setCurrentSessionId(sessionId);
          updateBrowserState(data.width, data.height, data.tier);
          setInteractionHistory([...fork.interactions]);
          resetMouseMoveCounter();

          // Register this session to the main view
          registerMainView(sessionId);

          console.log(`✓ Switched to forked session: ${sessionId.substring(0, 8)} - Replaying...`);
          setStatus(`Forked session ${sessionId.substring(0, 8)} - Replaying interactions...`, 'connected');
          updateSessionSelector(ws);
          updateUrlDisplay(fork.url);

          // Disable navigation during replay
          navigateBtn.disabled = true;

          // Replay interactions on the new session (async, in background)
          replayInteractions(send, setStatus, sessionId, fork.url, fork.interactions).then(() => {
            console.log('Fork replay complete');
            // Send message indicating fork is complete
            send({ type: 'forkComplete', sessionId });
          }).catch((error) => {
            console.error('Fork replay error:', error);
            setStatus('Fork replay failed', 'error');
            navigateBtn.disabled = false;
          });
        } else {
          // Normal session creation - switch to it
          setCurrentSessionId(sessionId);
          updateBrowserState(data.width, data.height, data.tier);
          setInteractionHistory([]);
          resetMouseMoveCounter();

          // Register this session to the main view
          registerMainView(sessionId);

          console.log(`✓ Active session is now: ${sessionId.substring(0, 8)} - All input will be sent to this session`);
          setStatus(`Active: Session ${sessionId.substring(0, 8)} | All input goes here`, 'connected');
          navigateBtn.disabled = false;
          updateSessionSelector(ws);
          updateUrlDisplay('');
        }
        break;
      }

      case 'sessionClosed': {
        const sessionId = data.sessionId;
        sessions.delete(sessionId);

        // Remove view registration for this session
        unregisterView(sessionId);

        if (sessionId === getCurrentSessionId()) {
          console.log('Current session closed:', sessionId);

          // Switch to another session if available
          const remainingSessions = Array.from(sessions.keys());
          if (remainingSessions.length > 0) {
            const state = switchToSession(
              remainingSessions[0],
              requestFrame,
              () => updateSessionSelector(ws),
              updateUrlDisplay,
              setStatus
            );
            if (state) {
              updateBrowserState(state.width, state.height, state.tier);
              registerMainView(remainingSessions[0]);
            }
          } else {
            setCurrentSessionId(null);
            navigateBtn.disabled = true;
            setStatus('Session closed', 'error');
          }
        }

        updateSessionSelector(ws);
        break;
      }

      case 'frame':
        dispatchFrame(data.sessionId, data.data, data.metadata);
        break;

      case 'navigationComplete':
        console.log(`Navigation complete for session ${data.sessionId?.substring(0, 8)}: ${data.url}`);

        // Update session URL
        const session = sessions.get(data.sessionId);
        if (session) {
          session.url = data.url;
        }

        // Update URL display if this is the current session
        if (data.sessionId === getCurrentSessionId()) {
          updateUrlDisplay(data.url);
          setCurrentUrl(data.url);
        }

        // Resolve navigation promise
        if (window.navigationPromises && window.navigationPromises[data.sessionId]) {
          window.navigationPromises[data.sessionId].resolve();
          delete window.navigationPromises[data.sessionId];
        }
        break;

      case 'status':
        if (data.sessionId === getCurrentSessionId() || !data.sessionId) {
          console.log('Status:', data.message);
        }
        break;

      case 'error':
        console.error('Error:', data.message);
        setStatus(data.message, 'error');
        if (data.sessionId && window.navigationPromises && window.navigationPromises[data.sessionId]) {
          window.navigationPromises[data.sessionId].reject(new Error(data.message));
          delete window.navigationPromises[data.sessionId];
        }
        break;

      case 'qualityTierChanged':
        if (data.sessionId === getCurrentSessionId()) {
          console.log(`Quality tier changed to: ${data.tier} (${data.width}x${data.height})`);
          updateBrowserState(data.width, data.height, data.tier);

          const session = sessions.get(data.sessionId);
          if (session) {
            session.tier = data.tier;
            session.width = data.width;
            session.height = data.height;
          }
        }
        break;

      case 'scrollPosition':
        // Handle scroll position responses for the input-handler module
        if (window.scrollPositionCallbacks && window.scrollPositionCallbacks.has(data.sessionId)) {
          const callback = window.scrollPositionCallbacks.get(data.sessionId);
          window.scrollPositionCallbacks.delete(data.sessionId);
          callback({ x: data.scrollX, y: data.scrollY });
        }
        break;

      case 'urlChanged':
        console.log(`URL changed for session ${data.sessionId?.substring(0, 8)}: ${data.url}`);

        // Update session URL
        const urlChangedSession = sessions.get(data.sessionId);
        if (urlChangedSession) {
          urlChangedSession.url = data.url;

          // Record this as a navigation checkpoint in the interaction history
          // This ensures fork knows where to navigate to
          const navCheckpoint = {
            type: 'navigate',
            url: data.url,
            timestamp: Date.now(),
          };
          urlChangedSession.interactionHistory.push(navCheckpoint);

          console.log(`Added navigation checkpoint: ${data.url}`);
        }

        // Update URL display if this is the current session
        if (data.sessionId === getCurrentSessionId()) {
          updateUrlDisplay(data.url);
          setCurrentUrl(data.url);

          // Also update the global interaction history
          const globalNavCheckpoint = {
            type: 'navigate',
            url: data.url,
            timestamp: Date.now(),
          };
          setInteractionHistory([...getInteractionHistory(), globalNavCheckpoint]);
        }
        break;

      case 'currentUrl':
        // Handle getCurrentUrl responses
        if (window.currentUrlCallbacks && window.currentUrlCallbacks.has(data.sessionId)) {
          const callback = window.currentUrlCallbacks.get(data.sessionId);
          window.currentUrlCallbacks.delete(data.sessionId);
          callback(data.url);
        }
        break;

      case 'forkComplete':
        console.log(`Fork complete for session ${data.sessionId?.substring(0, 8)}`);

        // Re-enable navigation if this is the current session
        if (data.sessionId === getCurrentSessionId()) {
          setStatus(`Active: Session ${data.sessionId.substring(0, 8)} | Ready for interaction`, 'connected');
          navigateBtn.disabled = false;
        }
        break;

      case 'scrollComplete':
        // Handle scroll complete confirmations
        if (window.scrollCompleteCallbacks && window.scrollCompleteCallbacks.has(data.sessionId)) {
          const callback = window.scrollCompleteCallbacks.get(data.sessionId);
          window.scrollCompleteCallbacks.delete(data.sessionId);
          callback();
        }
        break;
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    setStatus('Connection error', 'error');
  };

  ws.onclose = () => {
    setStatus('Disconnected', 'error');
    navigateBtn.disabled = true;

    // Clear all sessions since we disconnected
    sessions.clear();
    setCurrentSessionId(null);
    setInteractionHistory([]);
    resetMouseMoveCounter();
    updateSessionSelector(ws);

    // Attempt reconnection after 2 seconds
    setTimeout(() => {
      if (ws.readyState === WebSocket.CLOSED) {
        setStatus('Reconnecting...', '');
        connect();
      }
    }, 2000);
  };
}

// Send message to server
function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Request an immediate frame from a session
function requestFrame(sessionId) {
  if (!sessionId) return;
  send({ type: 'requestFrame', sessionId });
}

// Switch quality tier
function setQualityTier(tier) {
  const currentSessionId = getCurrentSessionId();
  const currentTierValue = getCurrentTier();
  if (tier !== currentTierValue && currentSessionId) {
    console.log(`Switching quality tier: ${currentTierValue} → ${tier}`);
    send({ type: 'setQualityTier', sessionId: currentSessionId, tier });
  }
}

// Initialize UI first
initializeUI();

// Get UI elements after initialization
const { canvas, sessionSelector, forkBtn, newSessionBtn } = getUIElements();
const extractTextBtn = document.getElementById('extractTextBtn');
const clickElementBtn = document.getElementById('clickElementBtn');
const elementIdInput = document.getElementById('elementIdInput');
const linksList = document.getElementById('linksList');

// Dynamic resolution adjustment based on canvas display size
function updateResolution() {
  const currentSessionId = getCurrentSessionId();
  if (!currentSessionId) return;

  const rect = canvas.getBoundingClientRect();
  const displayWidth = Math.round(rect.width * window.devicePixelRatio);
  const displayHeight = Math.round(rect.height * window.devicePixelRatio);

  // Get current dimensions
  const currentWidth = getBrowserWidth();
  const currentHeight = getBrowserHeight();

  // Only update if resolution changed significantly (more than 50px difference)
  if (Math.abs(displayWidth - currentWidth) > 50 || Math.abs(displayHeight - currentHeight) > 50) {
    console.log(`Canvas display size changed: ${displayWidth}x${displayHeight} (was ${currentWidth}x${currentHeight})`);

    // Send resolution update to server
    send({
      type: 'setResolution',
      sessionId: currentSessionId,
      width: displayWidth,
      height: displayHeight,
    });

    // Update local browser dimensions
    updateBrowserState(displayWidth, displayHeight, getCurrentTier());
  }
}

// Monitor canvas size changes
const resizeObserver = new ResizeObserver(() => {
  updateResolution();
});
resizeObserver.observe(canvas);

// Initial resolution update
setTimeout(updateResolution, 1000);

// Quality tier management based on focus and visibility
window.addEventListener('focus', () => {
  if (getCurrentSessionId()) {
    setQualityTier('primary');
  }
});

window.addEventListener('blur', () => {
  setQualityTier('secondary');
});

// Intersection Observer for offscreen detection
const visibilityObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.intersectionRatio === 0) {
      setQualityTier('background');
    } else if (entry.intersectionRatio < 1.0) {
      setQualityTier('secondary');
    } else {
      setQualityTier('primary');
    }
  });
}, {
  threshold: [0, 0.5, 1.0]
});

visibilityObserver.observe(canvas);

// Setup all input handlers
setupMouseHandlers(canvas, (data) => sendAndRecord(data, send));
setupKeyboardHandlers(canvas, (data) => sendAndRecord(data, send));
setupNavigationHandlers(urlInput, navigateBtn, (data) => sendAndRecord(data, send), setStatus);

// Session management event listeners

forkBtn.addEventListener('click', () => {
  forkSession(send, setStatus);
});

newSessionBtn.addEventListener('click', () => {
  createNewSession(send, 'primary');
});

sessionSelector.addEventListener('change', (e) => {
  const selectedSessionId = e.target.value;
  console.log('Session selector changed to:', selectedSessionId);

  if (selectedSessionId && selectedSessionId !== 'No sessions') {
    const state = switchToSession(
      selectedSessionId,
      requestFrame,
      () => updateSessionSelector(ws),
      updateUrlDisplay,
      setStatus
    );
    if (state) {
      updateBrowserState(state.width, state.height, state.tier);
      registerMainView(selectedSessionId);
    }
  } else {
    console.warn('Invalid session selected:', selectedSessionId);
  }
});

// Extract Text button handler
extractTextBtn.addEventListener('click', async () => {
  const currentSessionId = getCurrentSessionId();
  if (!currentSessionId) {
    console.warn('No active session - cannot extract text');
    setStatus('No active session', 'error');
    return;
  }

  console.log(`Extracting text from session ${currentSessionId.substring(0, 8)}...`);
  setStatus('Extracting text...', 'connected');
  extractTextBtn.disabled = true;

  try {
    const response = await fetch('/api/extract-text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extract text');
    }

    const data = await response.json();

    console.log('=== PAGE TEXT EXTRACTION ===');
    console.log(`Title: ${data.title}`);
    console.log(`URL: ${data.url}`);
    console.log(`Text Content Length: ${data.summary.characterCount} characters`);
    console.log(`Links Found: ${data.summary.uniqueLinks} unique (${data.summary.totalLinks} total)`);
    console.log('\n--- Formatted Output (LLM-friendly) ---\n');
    console.log(data.formatted);
    console.log('\n--- Raw Data (JSON) ---');
    console.log(data);
    console.log('=== END EXTRACTION ===');

    // Update UI with links
    displayLinks(data.uniqueLinks);

    setStatus(`Text extracted: ${data.summary.characterCount} chars, ${data.summary.uniqueLinks} links`, 'connected');
  } catch (error) {
    console.error('Error extracting text:', error);
    setStatus(`Extraction failed: ${error.message}`, 'error');
  } finally {
    extractTextBtn.disabled = false;
  }
});

// Display links in the UI
function displayLinks(uniqueLinks) {
  if (!linksList) return;

  if (!uniqueLinks || uniqueLinks.length === 0) {
    linksList.className = 'element-list empty';
    linksList.textContent = 'No links found';
    return;
  }

  linksList.className = 'element-list';
  linksList.innerHTML = '';

  uniqueLinks.forEach(link => {
    const item = document.createElement('div');
    item.className = 'element-item link';
    const text = link.texts[0]?.substring(0, 60) || '[no text]';
    const variants = link.texts.length > 1 ? ` (+${link.texts.length - 1})` : '';
    item.textContent = `[${link.firstId}] ${text}${variants}`;
    item.title = link.url;
    item.onclick = () => {
      elementIdInput.value = link.firstId;
    };
    linksList.appendChild(item);
  });
}

// Click element handler
clickElementBtn.addEventListener('click', async () => {
  const currentSessionId = getCurrentSessionId();
  const elementId = elementIdInput.value.trim();

  if (!currentSessionId) {
    console.warn('No active session - cannot click element');
    setStatus('No active session', 'error');
    return;
  }

  if (!elementId) {
    console.warn('No element ID provided');
    setStatus('Enter an element ID', 'error');
    return;
  }

  console.log(`Clicking element ${elementId}...`);
  setStatus(`Clicking ${elementId}...`, 'connected');
  clickElementBtn.disabled = true;

  try {
    const response = await fetch('/api/click-element', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: currentSessionId, elementId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to click element');
    }

    const data = await response.json();

    console.log('✓ Element clicked:', data);
    setStatus(`Clicked ${elementId}: ${data.text}`, 'connected');
  } catch (error) {
    console.error('Error clicking element:', error);
    setStatus(`Click failed: ${error.message}`, 'error');
  } finally {
    clickElementBtn.disabled = false;
  }
});

// Initialize session selector state
updateSessionSelector(ws);

// Initialize connection
connect();
