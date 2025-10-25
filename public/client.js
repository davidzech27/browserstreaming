// DOM elements
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const urlInput = document.getElementById('urlInput');
const navigateBtn = document.getElementById('navigateBtn');
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const currentUrlEl = document.getElementById('currentUrl');

// WebSocket connection
let ws = null;
let browserWidth = 2880;
let browserHeight = 1800;
let currentSessionId = null;

// Session management
const sessions = new Map(); // sessionId -> { id, url, interactionHistory, tier, width, height }

// Interaction recording for forking
let currentUrl = '';
let interactionHistory = [];
let mouseMoveCounter = 0; // For sampling mouse moves

// Quality tier tracking
let currentTier = 'primary';
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
    // Request a new session
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
          await replayInteractions(sessionId, fork.url, fork.interactions);

          // Don't switch to the forked session automatically
          updateSessionSelector();
        } else {
          // Normal session creation - switch to it
          currentSessionId = sessionId;
          browserWidth = data.width;
          browserHeight = data.height;
          interactionHistory = [];
          currentUrl = '';

          // Register this session to the main view
          registerMainView(sessionId);

          console.log(`✓ Active session is now: ${sessionId.substring(0, 8)} - All input will be sent to this session`);
          setStatus(`Active: Session ${sessionId.substring(0, 8)} | All input goes here`, 'connected');
          navigateBtn.disabled = false;
          updateSessionSelector();
          updateUrlDisplay('');
        }
        break;
      }

      case 'sessionClosed': {
        const sessionId = data.sessionId;
        sessions.delete(sessionId);

        // Remove view registration for this session
        activeViews.delete(sessionId);

        if (sessionId === currentSessionId) {
          console.log('Current session closed:', sessionId);

          // Switch to another session if available
          const remainingSessions = Array.from(sessions.keys());
          if (remainingSessions.length > 0) {
            switchToSession(remainingSessions[0]);
          } else {
            currentSessionId = null;
            navigateBtn.disabled = true;
            setStatus('Session closed', 'error');
          }
        }

        updateSessionSelector();
        break;
      }

      case 'frame':
        // Dispatch frame to any registered view for this session
        dispatchFrame(data.sessionId, data.data, data.metadata);
        break;

      case 'navigationComplete':
        console.log(`Navigation complete for session ${data.sessionId?.substring(0, 8)}: ${data.url}`);
        // Resolve any pending navigation promises
        if (window.navigationPromises && window.navigationPromises[data.sessionId]) {
          window.navigationPromises[data.sessionId].resolve();
          delete window.navigationPromises[data.sessionId];
        }
        break;

      case 'status':
        if (data.sessionId === currentSessionId || !data.sessionId) {
          console.log('Status:', data.message);
        }
        break;

      case 'error':
        console.error('Error:', data.message);
        setStatus(data.message, 'error');
        // Reject any pending navigation promises for this session
        if (data.sessionId && window.navigationPromises && window.navigationPromises[data.sessionId]) {
          window.navigationPromises[data.sessionId].reject(new Error(data.message));
          delete window.navigationPromises[data.sessionId];
        }
        break;

      case 'qualityTierChanged':
        if (data.sessionId === currentSessionId) {
          console.log(`Quality tier changed to: ${data.tier} (${data.width}x${data.height})`);
          browserWidth = data.width;
          browserHeight = data.height;

          // Update session
          const session = sessions.get(data.sessionId);
          if (session) {
            session.tier = data.tier;
            session.width = data.width;
            session.height = data.height;
          }
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
    currentSessionId = null;
    interactionHistory = [];
    currentUrl = '';
    updateSessionSelector();

    // Attempt reconnection after 2 seconds
    setTimeout(() => {
      if (ws.readyState === WebSocket.CLOSED) {
        setStatus('Reconnecting...', '');
        connect();
      }
    }, 2000);
  };
}

// View management - maps sessionId to render targets
// For now we have one view (the main canvas), but this is extensible
const activeViews = new Map(); // sessionId -> { canvas, ctx, render }

// Register the main canvas as a view for the current session
function registerMainView(sessionId) {
  if (!sessionId) return;

  // Clear previous registrations for main canvas
  activeViews.clear();

  // Register this session to the main canvas
  activeViews.set(sessionId, {
    canvas: canvas,
    ctx: ctx,
    render: (base64Data, metadata) => {
      loadingEl.style.display = 'none';

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
function dispatchFrame(sessionId, base64Data, metadata) {
  const view = activeViews.get(sessionId);
  if (view && view.render) {
    view.render(base64Data, metadata);
  }
}

// Legacy single-view render function (for backwards compatibility)
async function renderFrame(base64Data, metadata) {
  if (currentSessionId) {
    dispatchFrame(currentSessionId, base64Data, metadata);
  }
}

// Send message to server
function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Record interaction for replay
function recordInteraction(interaction) {
  const entry = {
    ...interaction,
    timestamp: Date.now()
  };

  interactionHistory.push(entry);

  // Also update the current session's history
  if (currentSessionId) {
    const session = sessions.get(currentSessionId);
    if (session) {
      session.interactionHistory.push(entry);
    }
  }
}

// Send and record interaction
function sendAndRecord(data) {
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
      currentUrl = data.url;
      interactionHistory = [];
      mouseMoveCounter = 0;

      // Update session
      if (currentSessionId) {
        const session = sessions.get(currentSessionId);
        if (session) {
          session.url = data.url;
          session.interactionHistory = [];
        }
      }

      // Update URL display
      updateUrlDisplay(data.url);

      // Record the navigate action after clearing
      recordInteraction(data);
    } else if (data.type === 'mouseMoved') {
      // Sample mouse moves - only record every 10th one to reduce history size
      mouseMoveCounter++;
      if (mouseMoveCounter % 10 === 0) {
        recordInteraction(data);
      }
    } else {
      // Record all other interactions normally
      recordInteraction(data);
    }
  }

  send(data);
}

// Update status display
function setStatus(message, className) {
  statusEl.textContent = message;
  statusEl.className = `status ${className}`;
}

// Update URL display
function updateUrlDisplay(url) {
  if (!currentUrlEl) return;

  if (url) {
    currentUrlEl.textContent = url;
    currentUrlEl.className = 'url-value';
  } else {
    currentUrlEl.textContent = 'No page loaded';
    currentUrlEl.className = 'url-value empty';
  }
}

// Request an immediate frame from a session (generic - works for any view)
function requestFrame(sessionId) {
  if (!sessionId) return;

  send({
    type: 'requestFrame',
    sessionId: sessionId
  });
}

// Navigate and wait for completion (returns a promise)
function navigateAndWait(sessionId, url) {
  return new Promise((resolve, reject) => {
    // Initialize navigation promises tracking
    if (!window.navigationPromises) {
      window.navigationPromises = {};
    }

    // Store the promise resolvers
    window.navigationPromises[sessionId] = { resolve, reject };

    // Send navigation request
    send({ type: 'navigate', sessionId, url });

    // Set a timeout in case something goes wrong
    setTimeout(() => {
      if (window.navigationPromises[sessionId]) {
        console.warn(`Navigation timeout for session ${sessionId.substring(0, 8)}`);
        delete window.navigationPromises[sessionId];
        resolve(); // Resolve anyway to continue
      }
    }, 35000); // 35 seconds (server has 30s timeout + buffer)
  });
}

// Switch to a different session
function switchToSession(sessionId) {
  if (sessionId === currentSessionId) {
    console.log('Already on this session:', sessionId);
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return;
  }

  console.log(`Switching from session ${currentSessionId?.substring(0, 8)} to ${sessionId.substring(0, 8)}`);

  // Update current session - this is the ONLY place currentSessionId should change (besides initial creation)
  currentSessionId = sessionId;
  currentUrl = session.url;
  interactionHistory = [...session.interactionHistory];
  browserWidth = session.width;
  browserHeight = session.height;
  currentTier = session.tier;

  // Register this session to the main view
  registerMainView(sessionId);

  // Request immediate frame update for the new session
  requestFrame(sessionId);

  // Update UI
  updateSessionSelector();
  updateUrlDisplay(session.url);
  setStatus(`Active: Session ${sessionId.substring(0, 8)} | All input goes here`, 'connected');
  console.log(`✓ Active session is now: ${sessionId.substring(0, 8)} - All input will be sent to this session`);
}

// Create a new session
async function createNewSession(tier = 'primary') {
  send({ type: 'createSession', tier });
}

// Fork current session with replay
async function forkSession() {
  if (!currentSessionId) {
    setStatus('No active session to fork', 'error');
    return;
  }

  const currentSession = sessions.get(currentSessionId);
  if (!currentSession) {
    setStatus('Current session not found', 'error');
    return;
  }

  console.log(`Forking session ${currentSessionId} with ${currentSession.interactionHistory.length} interactions`);
  setStatus('Forking session...', 'connected');

  // Request new session creation
  send({ type: 'createSession', tier: currentTier });

  // Store the fork info temporarily to replay after session is created
  window.pendingFork = {
    url: currentSession.url,
    interactions: [...currentSession.interactionHistory]
  };
}

// Replay interactions on a session
async function replayInteractions(sessionId, url, interactions) {
  console.log(`Replaying ${interactions.length} interactions on session ${sessionId.substring(0, 8)}`);

  // Filter out navigation events from interactions (we'll handle the URL separately)
  const filteredInteractions = interactions.filter(i => i.type !== 'navigate');

  // First navigate to the URL if there is one
  if (url) {
    console.log(`Navigating forked session to: ${url}`);

    try {
      // Wait for navigation to complete (server will send navigationComplete)
      await navigateAndWait(sessionId, url);
      console.log('Navigation completed, waiting additional time for dynamic content...');

      // Additional wait for dynamic sites to fully load
      const additionalWait = url.includes('google') || url.includes('facebook') || url.includes('twitter') ? 2000 : 1000;
      await new Promise(resolve => setTimeout(resolve, additionalWait));
    } catch (error) {
      console.error('Navigation failed during replay:', error);
      setStatus('Fork failed - navigation error', 'error');
      return;
    }
  }

  console.log(`Replaying ${filteredInteractions.length} interactions (after filtering navigations)`);

  // Replay interactions with intelligent timing
  for (let i = 0; i < filteredInteractions.length; i++) {
    const interaction = filteredInteractions[i];

    // Create a copy and update sessionId
    const replayData = { ...interaction, sessionId };
    delete replayData.timestamp;

    send(replayData);

    // Adaptive delays based on interaction type
    if (i < filteredInteractions.length - 1) {
      // Longer delay after clicks and key presses to let page respond
      if (interaction.type === 'mousePressed' || interaction.type === 'keyDown') {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Very short delay for mouse moves
      else if (interaction.type === 'mouseMoved') {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Short delay for other events
      else {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }

  console.log('Replay complete');
  setStatus('Fork complete', 'connected');
}

// Update session selector dropdown
function updateSessionSelector() {
  const selector = document.getElementById('sessionSelector');
  const forkBtn = document.getElementById('forkBtn');
  const newSessionBtn = document.getElementById('newSessionBtn');

  if (!selector) return;

  // Clear existing options
  selector.innerHTML = '';

  if (sessions.size === 0) {
    const option = document.createElement('option');
    option.textContent = 'No sessions';
    selector.appendChild(option);
    selector.disabled = true;
    if (forkBtn) forkBtn.disabled = true;
  } else {
    selector.disabled = false;
    if (forkBtn) forkBtn.disabled = !currentSessionId;

    // Add option for each session
    for (const [sessionId, session] of sessions) {
      const option = document.createElement('option');
      option.value = sessionId;
      const isActive = sessionId === currentSessionId;
      // Add visual indicator for active session
      option.textContent = `${isActive ? '▶ ' : ''}Session ${sessionId.substring(0, 8)}${session.url ? ` - ${session.url}` : ''}`;
      option.selected = isActive;
      selector.appendChild(option);
    }
  }

  // New session button is always enabled if WebSocket is connected
  if (newSessionBtn) {
    newSessionBtn.disabled = !ws || ws.readyState !== WebSocket.OPEN;
  }

  console.log(`Session selector updated. Active session: ${currentSessionId?.substring(0, 8) || 'none'}`);
}

// Get scaled coordinates (canvas -> browser viewport)
function getScaledCoordinates(event) {
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

// Switch quality tier
function setQualityTier(tier) {
  if (tier !== currentTier && currentSessionId) {
    console.log(`Switching quality tier: ${currentTier} → ${tier}`);
    currentTier = tier;
    send({ type: 'setQualityTier', sessionId: currentSessionId, tier });
  }
}

// Event handlers
navigateBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) {
    console.warn('No URL entered');
    return;
  }
  if (!currentSessionId) {
    console.warn('No active session - cannot navigate');
    setStatus('No active session', 'error');
    return;
  }
  console.log(`Navigating active session ${currentSessionId.substring(0, 8)} to: ${url}`);
  sendAndRecord({ type: 'navigate', sessionId: currentSessionId, url });
});

urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    navigateBtn.click();
  }
});

// Mouse events - send raw CDP-compatible events
canvas.addEventListener('mousedown', (e) => {
  if (!currentSessionId) {
    console.warn('No active session - ignoring mouse input');
    return;
  }

  const { x, y } = getScaledCoordinates(e);
  sendAndRecord({
    type: 'mousePressed',
    sessionId: currentSessionId,
    x,
    y,
    button: getButtonName(e.button),
    clickCount: e.detail,  // Browser provides click count!
    modifiers: getModifiers(e),
  });

  // Focus canvas for keyboard input
  canvasFocused = true;
  canvas.style.outline = '2px solid #0066ff';
});

canvas.addEventListener('mouseup', (e) => {
  if (!currentSessionId) return;

  const { x, y } = getScaledCoordinates(e);
  sendAndRecord({
    type: 'mouseReleased',
    sessionId: currentSessionId,
    x,
    y,
    button: getButtonName(e.button),
    clickCount: e.detail,
    modifiers: getModifiers(e),
  });
});

canvas.addEventListener('mousemove', (e) => {
  if (!currentSessionId) return;

  const { x, y } = getScaledCoordinates(e);
  sendAndRecord({
    type: 'mouseMoved',
    sessionId: currentSessionId,
    x,
    y,
    button: getActiveButton(e.buttons),
    modifiers: getModifiers(e),
  });
});

// Context menu - let right-click handle it naturally
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();  // Just prevent browser menu, right-click event handles the rest
});

// Keyboard events - focus management
let canvasFocused = false;

document.addEventListener('click', (e) => {
  if (!canvas.contains(e.target)) {
    canvasFocused = false;
    canvas.style.outline = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  if (canvasFocused && currentSessionId && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
    // Always prevent default for all keys when canvas is focused
    e.preventDefault();

    // Determine if this key should have text
    // Text should only be sent for printable characters (length 1) and some special cases
    let text = undefined;
    if (e.key.length === 1) {
      text = e.key;
    } else if (e.key === 'Enter') {
      text = '\r'; // CDP expects carriage return for Enter
    } else if (e.key === 'Tab') {
      text = '\t';
    }
    // For other keys (Backspace, Delete, Arrow keys, etc.), don't send text

    sendAndRecord({
      type: 'keyDown',
      sessionId: currentSessionId,
      key: e.key,
      code: e.code,
      text: text,
      modifiers: getModifiers(e),
    });
  }
});

document.addEventListener('keyup', (e) => {
  if (canvasFocused && currentSessionId && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    sendAndRecord({
      type: 'keyUp',
      sessionId: currentSessionId,
      key: e.key,
      code: e.code,
      modifiers: getModifiers(e),
    });
  }
});

// Clipboard events
document.addEventListener('paste', async (e) => {
  if (canvasFocused && currentSessionId) {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      sendAndRecord({ type: 'paste', sessionId: currentSessionId, text });
    }
  }
});

// Scroll/wheel events - send raw with modifiers for Ctrl+zoom
canvas.addEventListener('wheel', (e) => {
  if (!currentSessionId) return;

  e.preventDefault();
  const { x, y } = getScaledCoordinates(e);
  sendAndRecord({
    type: 'mouseWheel',
    sessionId: currentSessionId,
    x,
    y,
    deltaX: e.deltaX * 0.1,  // Scale down for natural scroll speed
    deltaY: e.deltaY * 0.1,  // Scale down for natural scroll speed
    modifiers: getModifiers(e),  // Enables Ctrl+scroll zoom!
  });
}, { passive: false });

// Quality tier management based on focus and visibility

// Focus/blur events for tier switching
window.addEventListener('focus', () => {
  if (canvasFocused) {
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
      // Completely offscreen
      setQualityTier('background');
    } else if (!canvasFocused) {
      // Partially visible but not focused
      setQualityTier('secondary');
    } {
      // Visible and focused
      setQualityTier('primary');
    }
  });
}, {
  threshold: [0, 0.5, 1.0]
});

// Start observing canvas visibility
visibilityObserver.observe(canvas);

// Session management event listeners
const forkBtn = document.getElementById('forkBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
const sessionSelector = document.getElementById('sessionSelector');

forkBtn.addEventListener('click', () => {
  forkSession();
});

newSessionBtn.addEventListener('click', () => {
  createNewSession('primary');
});

sessionSelector.addEventListener('change', (e) => {
  const selectedSessionId = e.target.value;
  console.log('Session selector changed to:', selectedSessionId);

  if (selectedSessionId && selectedSessionId !== 'No sessions') {
    switchToSession(selectedSessionId);
  } else {
    console.warn('Invalid session selected:', selectedSessionId);
  }
});

// Initialize UI state
updateSessionSelector();

// Initialize connection
connect();
