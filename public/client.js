// DOM elements
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const urlInput = document.getElementById('urlInput');
const navigateBtn = document.getElementById('navigateBtn');
const cloneBtn = document.getElementById('cloneBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const recordingStatusEl = document.getElementById('recordingStatus');
const eventCountEl = document.getElementById('eventCount');
const cacheSizeEl = document.getElementById('cacheSize');

// WebSocket connection
let ws = null;
const MACBOOK_VIEWPORT = {
  width: 1512,
  height: 982,
};

let viewportWidth = MACBOOK_VIEWPORT.width;
let viewportHeight = MACBOOK_VIEWPORT.height;
let streamWidth = MACBOOK_VIEWPORT.width;
let streamHeight = MACBOOK_VIEWPORT.height;
let serverReady = false;
let messageQueue = [];

// Quality tier tracking
let currentTier = 'primary';

// Connect to WebSocket
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // Check if we're reconnecting to an existing session
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('sessionId');

  const wsUrl = sessionId
    ? `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`
    : `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // Reset state for new connection
    serverReady = false;
    messageQueue = [];
    setStatus('Initializing...', '');
    // navigateBtn will be enabled when 'ready' message arrives
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'ready':
        console.log('[Client] Server ready! Flushing', messageQueue.length, 'queued messages');
        serverReady = true;
        if (data.viewport?.width && data.viewport?.height) {
          viewportWidth = data.viewport.width;
          viewportHeight = data.viewport.height;
          resizeCanvas(viewportWidth, viewportHeight);
        }

        // Flush all queued messages
        while (messageQueue.length > 0) {
          const queuedMsg = messageQueue.shift();
          ws.send(JSON.stringify(queuedMsg));
        }

        setStatus('Connected', 'connected');
        navigateBtn.disabled = false;
        break;

      case 'frame':
        await renderFrame(data.data, data.metadata);
        break;

      case 'status':
        console.log('Status:', data.message);
        break;

      case 'error':
        console.error('Error:', data.message);
        setStatus(data.message, 'error');
        break;

      case 'qualityTierChanged':
        console.log(`Quality tier changed to: ${data.tier} (${data.width}x${data.height})`);
        streamWidth = data.width;
        streamHeight = data.height;
        break;

      case 'cloneProgress':
        console.log(`Clone progress: ${data.stage} (${data.progress}%)`);
        setStatus(`Cloning: ${data.message || data.stage}`, 'connected');
        break;

      case 'cloneCreated':
        console.log('Clone created!', data);
        setStatus('Clone created!', 'connected');
        // Open clone in new window
        const cloneUrl = `${window.location.origin}/?sessionId=${data.targetConnectionId}`;
        window.open(cloneUrl, '_blank');
        break;

      case 'snapshotCaptured':
        console.log('Snapshot captured:', data);
        setStatus(
          `Snapshot captured (${data.snapshot.viewport.width}x${data.snapshot.viewport.height})`,
          'connected'
        );
        setTimeout(() => setStatus('Connected', 'connected'), 3000);
        break;

      case 'cacheStats':
        updateStats(data.stats, data.eventsRecorded);
        break;

      case 'recordingStatus':
        recordingStatusEl.textContent = data.isRecording ? 'Yes' : 'No';
        if (data.eventsRecorded !== undefined) {
          eventCountEl.textContent = data.eventsRecorded;
        }
        break;
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    setStatus('Connection error', 'error');
  };

  ws.onclose = () => {
    serverReady = false;
    messageQueue = [];
    setStatus('Disconnected', 'error');
    navigateBtn.disabled = true;

    // Attempt reconnection after 2 seconds
    setTimeout(() => {
      if (ws.readyState === WebSocket.CLOSED) {
        setStatus('Reconnecting...', '');
        connect();
      }
    }, 2000);
  };
}

// Render frame to canvas
async function renderFrame(base64Data, metadata) {
  loadingEl.style.display = 'none';

  // Update browser dimensions if changed
  if (metadata) {
    streamWidth = metadata.width || streamWidth;
    streamHeight = metadata.height || streamHeight;
  }

  // Create image from base64
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = `data:image/jpeg;base64,${base64Data}`;
}

// Send message to server
function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (serverReady) {
      // Server is ready, send immediately
      ws.send(JSON.stringify(data));
    } else {
      // Server not ready yet, queue the message
      messageQueue.push(data);
      console.log('[Client] Queued message (server not ready):', data.type);
    }
  }
}

// Update status display
function setStatus(message, className) {
  statusEl.textContent = message;
  statusEl.className = `status ${className}`;
}

// Update stats display
function updateStats(stats, eventsRecorded) {
  if (stats) {
    cacheSizeEl.textContent = stats.entries || 0;
  }
  if (eventsRecorded !== undefined) {
    eventCountEl.textContent = eventsRecorded;
  }
}

// Get scaled coordinates (canvas -> browser viewport)
function getScaledCoordinates(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = viewportWidth / rect.width;
  const scaleY = viewportHeight / rect.height;

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
  if (tier !== currentTier) {
    console.log(`Switching quality tier: ${currentTier} → ${tier}`);
    currentTier = tier;
    send({ type: 'setQualityTier', tier });
  }
}

// Event handlers
navigateBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) {
    send({ type: 'navigate', url });
  }
});

urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    navigateBtn.click();
  }
});

// Clone button - clone current session
cloneBtn.addEventListener('click', () => {
  console.log('Cloning session...');
  cloneBtn.disabled = true;
  send({
    type: 'cloneSession',
    options: {
      playbackSpeed: 0,  // Instant replay
      skipAnimations: true,
    }
  });
  // Re-enable after a delay
  setTimeout(() => {
    cloneBtn.disabled = false;
  }, 2000);
});

// Snapshot button - capture current state
snapshotBtn.addEventListener('click', () => {
  console.log('Capturing snapshot...');
  send({ type: 'captureSnapshot' });
});

// Periodically request cache stats
setInterval(() => {
  send({ type: 'getCacheStats' });
}, 2000);

// Mouse events - send raw CDP-compatible events
canvas.addEventListener('mousedown', (e) => {
  const { x, y } = getScaledCoordinates(e);
  send({
    type: 'mousePressed',
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
  const { x, y } = getScaledCoordinates(e);
  send({
    type: 'mouseReleased',
    x,
    y,
    button: getButtonName(e.button),
    clickCount: e.detail,
    modifiers: getModifiers(e),
  });
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = getScaledCoordinates(e);
  send({
    type: 'mouseMoved',
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
  if (canvasFocused && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    send({
      type: 'keyDown',
      key: e.key,
      code: e.code,
      text: e.key.length === 1 ? e.key : undefined,  // Only send text for printable chars
      modifiers: getModifiers(e),
    });
  }
});

document.addEventListener('keyup', (e) => {
  if (canvasFocused && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    send({
      type: 'keyUp',
      key: e.key,
      code: e.code,
      modifiers: getModifiers(e),
    });
  }
});

// Clipboard events
document.addEventListener('paste', async (e) => {
  if (canvasFocused) {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      send({ type: 'paste', text });
    }
  }
});

// Scroll/wheel events - send raw with modifiers for Ctrl+zoom
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { x, y } = getScaledCoordinates(e);
  send({
    type: 'mouseWheel',
    x,
    y,
    deltaX: e.deltaX,  // Scale down for natural scroll speed
    deltaY: e.deltaY,  // Scale down for natural scroll speed
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
    } else {
      // Visible and focused
      setQualityTier('primary');
    }
  });
}, {
  threshold: [0, 0.5, 1.0]
});

// Start observing canvas visibility
visibilityObserver.observe(canvas);

function resizeCanvas(width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

// Initialize connection
resizeCanvas(viewportWidth, viewportHeight);
connect();
