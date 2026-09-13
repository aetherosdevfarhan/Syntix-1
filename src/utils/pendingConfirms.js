// Tracks in-flight "&nuke" confirmation messages by message ID, so the 15-second expiry timer
// (set where the confirmation is sent) and the button handler (in interactionCreate.js) agree on
// whether a press is still valid. Without this, the "Confirm within 15 seconds" text in the embed
// was purely decorative — the button stayed clickable forever, so an owner could fat-finger a
// months-old confirmation message and wipe a server they'd long forgotten they'd typed &nuke in.
const pending = new Set();

function markPending(messageId) {
  pending.add(messageId);
}

// Atomically checks-and-removes. Returns true only for the FIRST caller for a given messageId —
// whichever of "the 15s expiry timer" or "a button press" gets there first wins, and the loser
// sees false. JS's single-threaded event loop makes this safe against a double-click race.
function consume(messageId) {
  const wasPending = pending.has(messageId);
  pending.delete(messageId);
  return wasPending;
}

module.exports = { markPending, consume };
