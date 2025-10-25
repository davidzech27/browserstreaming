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
  browserWidth,
  browserHeight,
  currentTier,
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
  background: { width: 1920, height: 1200 },
  secondary: { width: 1920, height: 1200 },
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

          // Replay interactions on the new session
          await replayInteractions(send, setStatus, sessionId, fork.url, fork.interactions);

          // Don't switch to the forked session automatically
          updateSessionSelector(ws);
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
  if (tier !== currentTier && currentSessionId) {
    console.log(`Switching quality tier: ${currentTier} → ${tier}`);
    send({ type: 'setQualityTier', sessionId: currentSessionId, tier });
  }
}

// Initialize UI first
initializeUI();

// Get UI elements after initialization
const { canvas, sessionSelector, forkBtn, newSessionBtn } = getUIElements();

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

// Initialize session selector state
updateSessionSelector(ws);

// Initialize connection
connect();
