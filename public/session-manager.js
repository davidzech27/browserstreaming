// Session management module
// Handles session creation, switching, forking, and replay

// Session management
export const sessions = new Map(); // sessionId -> { id, url, interactionHistory, tier, width, height }

// Current session state
let _currentSessionId = null;
let _currentUrl = '';
let _interactionHistory = [];
let _mouseMoveCounter = 0;

// Getters
export function getCurrentSessionId() {
  return _currentSessionId;
}

export function getCurrentUrl() {
  return _currentUrl;
}

export function getInteractionHistory() {
  return _interactionHistory;
}

// For backward compatibility
export const currentSessionId = getCurrentSessionId;

// Setters for current session state
export function setCurrentSessionId(id) {
  _currentSessionId = id;
}

export function setCurrentUrl(url) {
  _currentUrl = url;
}

export function setInteractionHistory(history) {
  _interactionHistory = history;
}

export function resetMouseMoveCounter() {
  _mouseMoveCounter = 0;
}

// Record interaction for replay
export function recordInteraction(interaction) {
  const entry = {
    ...interaction,
    timestamp: Date.now(),
  };

  _interactionHistory.push(entry);

  // Also update the current session's history
  if (_currentSessionId) {
    const session = sessions.get(_currentSessionId);
    if (session) {
      session.interactionHistory.push(entry);
    }
  }
}

// Record with mouse move sampling
export function recordWithSampling(interaction) {
  if (interaction.type === 'mouseMoved') {
    _mouseMoveCounter++;
    if (_mouseMoveCounter % 10 === 0) {
      recordInteraction(interaction);
    }
  } else {
    recordInteraction(interaction);
  }
}

// Create a new session request
export function createNewSession(sendFn, tier = 'primary') {
  sendFn({ type: 'createSession', tier });
}

// Get current URL from server (returns a promise)
export function getCurrentUrlFromServer(sendFn, sessionId) {
  return new Promise((resolve, reject) => {
    // Initialize currentUrl callbacks tracking
    if (!window.currentUrlCallbacks) {
      window.currentUrlCallbacks = new Map();
    }

    // Store the promise resolver
    window.currentUrlCallbacks.set(sessionId, resolve);

    // Send getCurrentUrl request
    sendFn({ type: 'getCurrentUrl', sessionId });

    // Set a timeout in case something goes wrong
    setTimeout(() => {
      if (window.currentUrlCallbacks && window.currentUrlCallbacks.has(sessionId)) {
        console.warn(`getCurrentUrl timeout for session ${sessionId.substring(0, 8)}`);
        window.currentUrlCallbacks.delete(sessionId);
        resolve(null); // Resolve with null on timeout
      }
    }, 5000);
  });
}

// Fork current session with replay
export async function forkSession(sendFn, setStatusFn) {
  if (!_currentSessionId) {
    setStatusFn('No active session to fork', 'error');
    return;
  }

  const currentSession = sessions.get(_currentSessionId);
  if (!currentSession) {
    setStatusFn('Current session not found', 'error');
    return;
  }

  console.log(`Forking session ${_currentSessionId} - getting current URL from server...`);
  setStatusFn('Getting current URL...', 'connected');

  // Get the actual current URL from the server
  const actualUrl = await getCurrentUrlFromServer(sendFn, _currentSessionId);

  if (actualUrl) {
    console.log(`Current URL from server: ${actualUrl}`);
    // Update the session with the actual URL
    currentSession.url = actualUrl;
    _currentUrl = actualUrl;
  } else {
    console.warn('Failed to get current URL, using stored URL:', currentSession.url);
  }

  console.log(`Forking session ${_currentSessionId} with ${currentSession.interactionHistory.length} interactions`);
  setStatusFn('Forking session...', 'connected');

  // Request new session creation
  sendFn({ type: 'createSession', tier: currentSession.tier });

  // Store the fork info temporarily to replay after session is created
  window.pendingFork = {
    url: currentSession.url,
    interactions: [...currentSession.interactionHistory]
  };
}

// Navigate and wait for completion (returns a promise)
export function navigateAndWait(sendFn, sessionId, url) {
  return new Promise((resolve, reject) => {
    // Initialize navigation promises tracking
    if (!window.navigationPromises) {
      window.navigationPromises = {};
    }

    // Store the promise resolvers
    window.navigationPromises[sessionId] = { resolve, reject };

    // Send navigation request
    sendFn({ type: 'navigate', sessionId, url });

    // Set a timeout in case something goes wrong
    setTimeout(() => {
      if (window.navigationPromises[sessionId]) {
        console.warn(`Navigation timeout for session ${sessionId.substring(0, 8)}`);
        delete window.navigationPromises[sessionId];
        resolve(); // Resolve anyway to continue
      }
    }, 65000); // 65 seconds (server has 60s timeout + buffer)
  });
}

// Replay interactions on a session
export async function replayInteractions(sendFn, setStatusFn, sessionId, url, interactions) {
  console.log(`Replaying from ${interactions.length} total interactions on session ${sessionId.substring(0, 8)}`);

  // Find the last navigation event as a checkpoint
  let lastNavigationIndex = -1;
  let checkpointUrl = url;

  // Log all navigate events for debugging
  const navEvents = interactions
    .map((int, idx) => ({ ...int, idx }))
    .filter(int => int.type === 'navigate');
  console.log(`Found ${navEvents.length} navigation events in history:`, navEvents.map(e => `[${e.idx}] ${e.url}`));

  for (let i = interactions.length - 1; i >= 0; i--) {
    if (interactions[i].type === 'navigate') {
      lastNavigationIndex = i;
      checkpointUrl = interactions[i].url;
      break;
    }
  }

  // Only replay interactions after the last navigation checkpoint
  const interactionsToReplay = lastNavigationIndex >= 0
    ? interactions.slice(lastNavigationIndex + 1)
    : interactions;

  console.log(`Using checkpoint at index ${lastNavigationIndex}: ${checkpointUrl}`);
  console.log(`Replaying ${interactionsToReplay.length} interactions after checkpoint`);

  // Navigate to the checkpoint URL
  if (checkpointUrl) {
    console.log(`Navigating forked session to checkpoint: ${checkpointUrl}`);
    setStatusFn(`Navigating to ${checkpointUrl}...`, 'connected');

    try {
      // Wait for navigation to complete (server will send navigationComplete)
      // Server now waits for 'load' event + network idle, so no additional wait needed
      await navigateAndWait(sendFn, sessionId, checkpointUrl);
      console.log('Navigation completed, page fully loaded - starting replay...');
    } catch (error) {
      console.error('Navigation failed during replay:', error);
      setStatusFn('Fork failed - navigation error', 'error');
      return;
    }
  }

  // Filter out scroll-only interactions (mouseWheel events)
  // Keep all other interactions, but we'll handle scroll positions differently
  const nonScrollInteractions = interactionsToReplay.filter(int => int.type !== 'mouseWheel');

  console.log(`Replaying ${nonScrollInteractions.length} non-scroll interactions (filtered from ${interactionsToReplay.length} total)`);
  setStatusFn(`Replaying ${nonScrollInteractions.length} interactions...`, 'connected');

  // Add a small delay after navigation to ensure page is stable
  await new Promise(resolve => setTimeout(resolve, 200));

  // Track last scroll position to avoid redundant updates
  let lastScrollX = 0;
  let lastScrollY = 0;

  // Replay interactions with timestamp-based timing (compressed)
  for (let i = 0; i < nonScrollInteractions.length; i++) {
    const interaction = nonScrollInteractions[i];

    // Before replaying this interaction, jump directly to its scroll position
    // This skips all intermediate scroll events
    if (interaction.scrollX !== undefined && interaction.scrollY !== undefined) {
      // Only update if scroll position changed
      if (interaction.scrollX !== lastScrollX || interaction.scrollY !== lastScrollY) {
        console.log(`Jumping to scroll position (${interaction.scrollX}, ${interaction.scrollY}) before ${interaction.type}`);

        // Create a promise to wait for scroll to complete
        const scrollPromise = new Promise((resolve) => {
          const scrollCallback = (data) => {
            if (data.type === 'scrollComplete' && data.sessionId === sessionId) {
              resolve();
            }
          };

          // Set up temporary listener
          if (!window.scrollCompleteCallbacks) {
            window.scrollCompleteCallbacks = new Map();
          }
          window.scrollCompleteCallbacks.set(sessionId, resolve);

          // Timeout after 100ms in case we don't get confirmation
          setTimeout(resolve, 100);
        });

        sendFn({
          type: 'setScrollPosition',
          sessionId,
          scrollX: interaction.scrollX,
          scrollY: interaction.scrollY,
        });

        lastScrollX = interaction.scrollX;
        lastScrollY = interaction.scrollY;

        // Wait for scroll to complete (or timeout)
        await scrollPromise;

        // Additional small delay to ensure rendering is complete
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Create a copy and update sessionId
    const replayData = { ...interaction, sessionId };
    delete replayData.timestamp;
    delete replayData.scrollX;
    delete replayData.scrollY;

    // Log keyboard events for debugging
    if (replayData.type === 'keyDown' || replayData.type === 'keyUp') {
      console.log(`Replaying ${replayData.type}: key="${replayData.key}" code="${replayData.code}" text="${replayData.text}"`);
    }

    sendFn(replayData);

    // Use actual timestamps with compression for more natural replay
    if (i < nonScrollInteractions.length - 1) {
      const currentTimestamp = interaction.timestamp || 0;
      const nextTimestamp = nonScrollInteractions[i + 1].timestamp || 0;

      // Calculate actual time difference
      const actualDelay = nextTimestamp - currentTimestamp;

      // Compress delays: cap at 100ms max, minimum 1ms for ordering
      const compressedDelay = Math.min(Math.max(actualDelay, 1), 100);

      await new Promise(resolve => setTimeout(resolve, compressedDelay));
    }
  }

  console.log('Replay complete - fork ready for interaction');
}

// Switch to a different session
export function switchToSession(
  sessionId,
  requestFrameFn,
  updateSessionSelectorFn,
  updateUrlDisplayFn,
  setStatusFn
) {
  if (sessionId === _currentSessionId) {
    console.log('Already on this session:', sessionId);
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return;
  }

  console.log(`Switching from session ${_currentSessionId?.substring(0, 8)} to ${sessionId.substring(0, 8)}`);

  // Update current session
  _currentSessionId = sessionId;
  _currentUrl = session.url;
  _interactionHistory = [...session.interactionHistory];

  // Request immediate frame update for the new session
  requestFrameFn(sessionId);

  // Update UI
  updateSessionSelectorFn();
  updateUrlDisplayFn(session.url);
  setStatusFn(`Active: Session ${sessionId.substring(0, 8)} | All input goes here`, 'connected');
  console.log(`✓ Active session is now: ${sessionId.substring(0, 8)} - All input will be sent to this session`);

  return { width: session.width, height: session.height, tier: session.tier };
}

// Handle navigation in current session
export function handleNavigation(url, updateUrlDisplayFn) {
  _currentUrl = url;

  // Don't clear interaction history - we want to keep navigation checkpoints
  // Instead, the navigate event will be recorded as a checkpoint
  _mouseMoveCounter = 0;

  // Update session URL
  if (_currentSessionId) {
    const session = sessions.get(_currentSessionId);
    if (session) {
      session.url = url;
    }
  }

  // Update URL display
  updateUrlDisplayFn(url);
}
