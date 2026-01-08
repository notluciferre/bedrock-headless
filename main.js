const bedrock = require("bedrock-protocol");
const { randomUUID } = require("crypto");
const fs = require("fs");

// Load config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// DonutSMP target
const HOST = config.server.host;
const PORT = config.server.port;
const VERSION = config.server.version;
const USERNAME = config.auth.username;

// Scenario target
const TARGET_COMMAND = config.behavior.targetCommand;
const TARGET_SLOT_INDEX = config.behavior.slotIndex; // 0-based

let desiredTakeSlotIndex = TARGET_SLOT_INDEX;
let containerItemsDumpedForWindow = null;
let lastUiCandidateSignature = null;

/**
 * Minimal FSM for the required workflow.
 * We gate every action on protocol states to avoid invalid/early packets.
 */
const State = Object.freeze({
    CONNECTING: "CONNECTING",
    WAIT_SPAWN: "WAIT_SPAWN",
    WAIT_AVAILABLE_COMMANDS: "WAIT_AVAILABLE_COMMANDS",
    WAIT_INVENTORY_READY: "WAIT_INVENTORY_READY",
    READY: "READY",
    COMMAND_SENT: "COMMAND_SENT",
    WAIT_UI: "WAIT_UI",
    CONTAINER_OPENED: "CONTAINER_OPENED",
    WAIT_CONTAINER_CONTENT: "WAIT_CONTAINER_CONTENT",
    CLICK_SENT: "CLICK_SENT",
    DONE: "DONE",
});

let client;
let state = State.CONNECTING;

let availableCommandsSeen = false;
let inventoryReady = false;
let inventoryReadyReason = null;
let inventoryReadyFallbackTimer = null;

let currentWindowId = null;
let currentWindowType = null;
let currentWindowItems = null;

let playerInventoryItems = null; // window 0 snapshot (array of Item)

let clickSent = false;
let commandSent = false;
let autoCommandSent = false;
let commandSentCount = 0;

// Auto reconnect (enabled after the first manual `connect`)
let wantConnected = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pendingReconnectReason = null;
let pendingReconnectDelayMs = null;
let userInitiatedConnect = false; // Track if user used 'connect' command

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect(reason, delayMs) {
    // Only auto-reconnect if user initiated connect AND config allows it
    if (!userInitiatedConnect || !config.behavior.autoReconnect) {
        console.log(`[reconnect] disabled - user must reconnect manually`);
        return;
    }
    if (!wantConnected) return;
    if (client) return; // already connected/connecting
    if (reconnectTimer) return; // already scheduled

    const attempt = reconnectAttempt;
    const configDelay = config.behavior.reconnectDelayMs || RECONNECT_BASE_MS;
    const base = Math.min(
        RECONNECT_MAX_MS,
        configDelay * Math.pow(2, Math.min(attempt, 6))
    );
    const jitter = Math.floor(Math.random() * 500);
    const wait = Math.max(250, (delayMs ? ? base) + jitter);

    console.log(`[reconnect] in ${wait}ms (attempt ${attempt + 1}) - ${reason}`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempt++;
        connectServer();
    }, wait);
}

const WINDOW_ID_NAME_TO_NUM = Object.freeze({
    inventory: 0,
    first: 1,
    last: 100,
    offhand: 119,
    armor: 120,
    creative: 121,
    hotbar: 122,
    fixed_inventory: 123,
    ui: 124,
    none: -1,

    // WindowIDVarint extras
    drop_contents: -100,
    beacon: -24,
    trading_output: -23,
    trading_use_inputs: -22,
    trading_input_2: -21,
    trading_input_1: -20,
    enchant_output: -17,
    enchant_material: -16,
    enchant_input: -15,
    anvil_output: -13,
    anvil_result: -12,
    anvil_material: -11,
    container_input: -10,
    crafting_use_ingredient: -5,
    crafting_result: -4,
    crafting_remove_ingredient: -3,
    crafting_add_ingredient: -2,
});

function normalizeWindowId(windowId) {
    if (typeof windowId === "number") return windowId;
    if (typeof windowId === "bigint") return Number(windowId);
    if (typeof windowId === "string") {
        const asNumber = Number(windowId);
        if (Number.isFinite(asNumber)) return asNumber;
        const mapped = WINDOW_ID_NAME_TO_NUM[windowId];
        return typeof mapped === "number" ? mapped : windowId;
    }
    return windowId;
}

function isPlayerInventoryWindowId(windowId) {
    const id = normalizeWindowId(windowId);
    // Window 0 is the main player inventory; 119/120 are offhand/armor.
    return id === 0 || id === 1 || id === 2 || id === 119 || id === 120;
}

const PLAYER_INVENTORY_WINDOW_ID = 0;
const EMPTY_ITEM = { network_id: 0 };

function isEmptyItem(item) {
    if (!item) return true;
    return item.network_id === 0;
}

function stripMinecraftFormatting(text) {
    if (typeof text !== "string") return text;
    return text.replace(/§./g, "");
}

function findFirstEmptyPlayerSlot() {
    if (!Array.isArray(playerInventoryItems)) return null;
    for (let i = 0; i < playerInventoryItems.length; i++) {
        if (isEmptyItem(playerInventoryItems[i])) return i;
    }
    return null;
}

function setState(next, reason) {
    if (state === next) return;
    console.log(`[fsm] ${state} -> ${next}${reason ? ` (${reason})` : ""}`);
  state = next;
}

function formatItemShort(item) {
  if (!item || item.network_id === 0) return "<empty>";
  const count = item.count ?? "?";
  const meta = item.metadata ?? 0;
  const stackId = item.stack_id ?? null;
  return `id=${item.network_id} x${count} meta=${meta}${
    stackId != null ? ` stackId=${stackId}` : ""
  }`;
}

function dumpContainerItems(windowId, items) {
  if (!Array.isArray(items)) return;
  console.log(
    `[ui] container window ${windowId} items (size=${items.length}):`
  );
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.network_id === 0) continue;
    console.log(`  [${i}] ${formatItemShort(it)}`);
  }
}

function isUiLikeContainerSnapshot({ windowId, containerId, dynamicId, size }) {
  // Player inventory snapshots are commonly exactly 36.
  if (size === 36) return false;

  // If server provides a container_id that isn't clearly player-inventory-ish, treat it as UI.
  const inventoryLike = new Set([
    "inventory",
    "hotbar",
    "hotbar_and_inventory",
    "offhand",
    "armor",
  ]);
  if (typeof containerId === "string" && !inventoryLike.has(containerId)) {
    return true;
  }

  // If it has a dynamic container id (common for UI/container views), treat it as UI.
  if (typeof dynamicId === "number" && Number.isFinite(dynamicId)) {
    return true;
  }

  // Fallback: unusual sizes (9/18/27/45/54) during WAIT_UI are likely a UI view.
  if (size > 0 && size !== 36) return true;

  return false;
}

function maybeTakeDesiredSlot() {
  if (currentWindowId == null) return;
  if (!Number.isInteger(desiredTakeSlotIndex) || desiredTakeSlotIndex < 0)
    return;
  if (!Array.isArray(currentWindowItems)) return;

  if (desiredTakeSlotIndex >= currentWindowItems.length) {
    console.log(
      `[take] desired slot ${desiredTakeSlotIndex} out of range (container size=${currentWindowItems.length})`
    );
    return;
  }

  // Ensure we're in the right state gate.
  if (state !== State.WAIT_CONTAINER_CONTENT) {
    setState(State.WAIT_CONTAINER_CONTENT, "auto take");
  }
  clickSlot(currentWindowId, desiredTakeSlotIndex);
}

function logIn(name, params) {
  // Log only key packets to keep output readable.
  if (
    name === "available_commands" ||
    name === "inventory_content" ||
    (name === "inventory_slot" && state === State.WAIT_INVENTORY_READY) ||
    (name === "start_game" && state !== State.DONE) ||
    name === "container_open" ||
    name === "container_close" ||
    name === "modal_form_request" ||
    name === "command_output" ||
    name === "disconnect"
  ) {
    console.log(`[in ] ${name}`);
  }
}

function logOut(name, params) {
  console.log(
    `[out] ${name} ${name === "command_request" ? params?.command : ""}`.trim()
  );
}

function send(name, params) {
  logOut(name, params);
  if (!client) throw new Error("Client not connected");
  try {
    client.queue(name, params);
    return true;
  } catch (err) {
    console.log(`⚠️  failed to send ${name}: ${String(err?.message || err)}`);
    return false;
  }
}

function sendCommand(commandLine) {
  if (!commandLine.startsWith("/")) commandLine = "/" + commandLine;

  // Starting a new UI flow (e.g. /tpa) should clear previous UI/container state.
  // Otherwise we may keep a stale window and never infer the new GUI.
  currentWindowId = null;
  currentWindowType = null;
  currentWindowItems = null;
  containerItemsDumpedForWindow = null;
  lastUiCandidateSignature = null;
  clickSent = false;

  // IMPORTANT: command_request.version is a *string* in minecraft-data (bedrock 1.21.x)
  // CommandOrigin schema (minecraft-data bedrock latest/types.yml):
  // { type: string, uuid: uuid, request_id: string, player_entity_id: li64 }
  const ok = send("command_request", {
    command: commandLine,
    origin: {
      type: "player",
      uuid: randomUUID(),
      request_id: "",
      player_entity_id: 0n,
    },
    internal: false,
    version: "52",
  });

  if (!ok) return;
  commandSent = true;
  commandSentCount++;
  setState(State.COMMAND_SENT, "sent command_request");
  setState(State.WAIT_UI, "waiting UI (container_open or modal_form_request)");
}

function canSendCommands() {
  return Boolean(client) && availableCommandsSeen;
}

function onMaybeReady() {
  if (
    availableCommandsSeen &&
    inventoryReady &&
    state !== State.READY &&
    state !== State.WAIT_UI &&
    state !== State.COMMAND_SENT
  ) {
    setState(State.READY, "commands+inventory ready");
  }

  if (state === State.READY && !commandSent) {
    // Safe, realistic delay after READY to avoid racing server-side init.
    setTimeout(() => {
      if (state !== State.READY || autoCommandSent) return;
      console.log(`[scenario] sending ${TARGET_COMMAND}`);
      sendCommand(TARGET_COMMAND);
      autoCommandSent = true;
    }, 600);
  }
}

function markInventoryReady(reason) {
  if (inventoryReady) return;
  inventoryReady = true;
  inventoryReadyReason = reason;
  if (inventoryReadyFallbackTimer) {
    clearTimeout(inventoryReadyFallbackTimer);
    inventoryReadyFallbackTimer = null;
  }
  if (state === State.WAIT_INVENTORY_READY) {
    setState(State.READY, reason);
  }
  onMaybeReady();
}

function armInventoryReadyFallback() {
  if (inventoryReady || inventoryReadyFallbackTimer) return;
  inventoryReadyFallbackTimer = setTimeout(() => {
    if (inventoryReady) return;
    console.log(
      "⚠️  inventory init packets not seen; continuing with fallback readiness"
    );
    markInventoryReady("fallback timeout");
  }, 15000);
}

function buildNormalClickTransaction({ windowId, slotIndex, item }) {
  // Transaction schema from minecraft-data bedrock latest/types.yml:
  // packet_inventory_transaction: { transaction: Transaction }
  // Transaction: { legacy, transaction_type, actions, transaction_data }
  return {
    legacy: {
      legacy_request_id: 0,
    },
    transaction_type: "normal",
    actions: [
      {
        source_type: "container",
        inventory_id: windowId,
        slot: slotIndex,
        old_item: item,
        new_item: item,
      },
    ],
    // transaction_data omitted for normal
  };
}

function buildMoveToInventoryTransaction({ windowId, fromSlot, toSlot, item }) {
  // Moves `item` from container window -> player inventory (window 0).
  // We model this as 2 actions: remove from container slot, add to player slot.
  return {
    legacy: {
      legacy_request_id: 0,
    },
    transaction_type: "normal",
    actions: [
      {
        source_type: "container",
        inventory_id: windowId,
        slot: fromSlot,
        old_item: item,
        new_item: EMPTY_ITEM,
      },
      {
        source_type: "container",
        inventory_id: PLAYER_INVENTORY_WINDOW_ID,
        slot: toSlot,
        old_item: EMPTY_ITEM,
        new_item: item,
      },
    ],
  };
}

function clickSlot(windowId, slotIndex) {
  if (clickSent) return;
  if (state !== State.WAIT_CONTAINER_CONTENT) return;
  if (!currentWindowItems) return;
  if (currentWindowId == null || windowId !== currentWindowId) return;
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return;

  const item = currentWindowItems[slotIndex];
  if (!item || isEmptyItem(item)) {
    console.log(
      `[click] slot ${slotIndex} is empty/undefined; waiting for content...`
    );
    return;
  }

  const destSlot = findFirstEmptyPlayerSlot();
  const tx = Number.isInteger(destSlot)
    ? buildMoveToInventoryTransaction({
        windowId,
        fromSlot: slotIndex,
        toSlot: destSlot,
        item,
      })
    : buildNormalClickTransaction({ windowId, slotIndex, item });

  if (!Number.isInteger(destSlot)) {
    console.log(
      "[click] player inventory unknown/full; falling back to click transaction"
    );
  } else {
    console.log(`[take] moving slot ${slotIndex} -> inv slot ${destSlot}`);
  }

  const ok = send("inventory_transaction", { transaction: tx });
  if (!ok) return;
  clickSent = true;
  setState(State.CLICK_SENT, `took slot ${slotIndex} (window ${windowId})`);
}

function tryTakeFromOpenContainer(slotIndex) {
  if (currentWindowId == null) {
    if (lastUiCandidateSignature) {
      console.log(
        `[take] no container window active yet (last UI candidate: ${lastUiCandidateSignature})`
      );
    } else {
      console.log("[take] no container window active yet");
    }
    return;
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0) {
    console.log("[take] invalid slot index");
    return;
  }
  if (currentWindowItems) {
    if (state !== State.WAIT_CONTAINER_CONTENT) {
      setState(State.WAIT_CONTAINER_CONTENT, "manual take");
    }
    clickSent = false;
    clickSlot(currentWindowId, slotIndex);
    return;
  }
  console.log("[take] waiting for container inventory_content...");
  setState(State.WAIT_CONTAINER_CONTENT, "manual take waiting content");
}

function connectServer() {
  if (client) {
    console.log("[boot] already connected");
    return;
  }

  // Enable reconnect attempts after a manual connect.
  wantConnected = true;
  userInitiatedConnect = true; // Mark as user-initiated
  clearReconnectTimer();

  console.log(
    `[boot] connecting to ${HOST}:${PORT} as ${USERNAME} (version ${VERSION})`
  );
  client = bedrock.createClient({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    offline: false,
    skipPing: true,
  });

  setState(State.WAIT_SPAWN, "created client");

  // Packet-level logging
  client.on("packet", (des) => {
    try {
      const name = des?.data?.name;
      const params = des?.data?.params;
      if (name) logIn(name, params);
    } catch {}
  });

  client.on("error", (err) => {
    const msg = String(err?.message || err);
    if (msg.includes("Read error") || msg.includes("Invalid tag")) {
      // DonutSMP appears to send custom/extended data that trips the decoder.
      // We intentionally ignore these to keep the bot running, and to avoid log spam.
      return;
    }
    if (msg.toLowerCase().includes("connect timed out")) {
      console.log("⚠️  connect timed out; resetting client");
      try {
        client?.close();
      } catch {}
      client = undefined;
      setState(State.CONNECTING, "connect timeout");

      // Reconnect with backoff.
      scheduleReconnect("connect timeout", pendingReconnectDelayMs ?? undefined);
      pendingReconnectDelayMs = null;
      return;
    }
    console.log("⚠️  error:", msg);
  });

  client.on("kick", (reason) => {
    console.log("✗ kicked:", JSON.stringify(reason));
    // Prefer to let the 'close' handler do cleanup; set a reconnect hint here.
    const msg = String(reason?.message || "");
    pendingReconnectReason = `kicked: ${msg || "unknown"}`;
    // If server says "already online", wait longer to avoid hammering.
    if (msg.toLowerCase().includes("already online")) {
      pendingReconnectDelayMs = 30000;
    }
    try {
      client?.close();
    } catch {}
    setState(State.CONNECTING, "kicked");
  });
  client.on("close", () => {
    console.log("✗ connection closed");
    client = undefined;
    availableCommandsSeen = false;
    inventoryReady = false;
    inventoryReadyReason = null;
    currentWindowId = null;
    currentWindowType = null;
    currentWindowItems = null;
    playerInventoryItems = null;
    clickSent = false;
    commandSent = false;
    autoCommandSent = false;
    commandSentCount = 0;
    containerItemsDumpedForWindow = null;

    const reason = pendingReconnectReason || "closed";
    const delay = pendingReconnectDelayMs;
    pendingReconnectReason = null;
    pendingReconnectDelayMs = null;

    setState(State.CONNECTING, "closed");
    scheduleReconnect(reason, delay ?? undefined);
  });

  // State gates
  client.on("spawn", () => {
    console.log("✓ spawn");
    setState(State.WAIT_AVAILABLE_COMMANDS, "spawned");
    onMaybeReady();
  });

  // Some servers reliably send start_game but may omit early inventory_content.
  client.on("start_game", () => {
    // We still require available_commands before we actually send commands.
    if (!inventoryReady) markInventoryReady("start_game");
  });

  client.on("available_commands", () => {
    availableCommandsSeen = true;
    if (state === State.WAIT_AVAILABLE_COMMANDS) {
      setState(State.WAIT_INVENTORY_READY, "available_commands");
      armInventoryReadyFallback();
    }
    onMaybeReady();
  });

  // Inventory ready: we consider player inventory content as readiness.
  client.on("inventory_content", (packet) => {
    // packet_inventory_content fields: window_id (varint), input (items), container, storage_item
    const rawWindowId = packet?.window_id;
    const windowId = normalizeWindowId(rawWindowId);
    if (windowId == null) return;

    const containerId = packet?.container?.container_id;
    const dynamicId = packet?.container?.dynamic_container_id;
    const size = Array.isArray(packet.input) ? packet.input.length : 0;

    if (state === State.WAIT_UI) {
      const sig = `win=${String(rawWindowId)}(norm=${String(
        windowId
      )}) cid=${String(containerId)} dyn=${
        dynamicId == null ? "-" : String(dynamicId)
      } size=${size}`;
      if (sig !== lastUiCandidateSignature) {
        // One-line debug for UI detection, only while WAIT_UI.
        console.log(`[ui] candidate ${sig}`);
        lastUiCandidateSignature = sig;
      }
    }

    // If we are waiting for a UI and container_open can't be decoded, infer a container window
    // directly from inventory_content packets.
    // NOTE: Some servers (like DonutSMP) may keep window_id=inventory (0) but change the container_id
    // and send a different-sized snapshot for the UI.
    if (state === State.WAIT_UI && currentWindowId == null) {
      const looksUi = isUiLikeContainerSnapshot({
        windowId,
        containerId,
        dynamicId,
        size,
      });

      if (!isPlayerInventoryWindowId(windowId) || looksUi) {
        currentWindowId = windowId;
        currentWindowType = null;
        currentWindowItems = null;
        clickSent = false;
        containerItemsDumpedForWindow = null;
        console.log(
          `[ui] inferred container windowId=${String(
            rawWindowId
          )} (normalized=${String(currentWindowId)}) container_id=${String(
            containerId
          )} size=${size}`
        );
        setState(
          State.CONTAINER_OPENED,
          "inferred container via inventory_content"
        );
        setState(
          State.WAIT_CONTAINER_CONTENT,
          "waiting inventory_content for window"
        );
      }
    }

    // Heuristic: player inventory is usually window 0 in many flows.
    // We only need *some* inventory init signal before command.
    if (!inventoryReady && isPlayerInventoryWindowId(windowId)) {
      markInventoryReady("inventory_content (player)");
    }

    // Keep a snapshot of player inventory (window 0) so we can choose an empty slot for "take".
    if (
      windowId === PLAYER_INVENTORY_WINDOW_ID &&
      Array.isArray(packet.input)
    ) {
      playerInventoryItems = packet.input;
    }

    // Container content for active window
    if (currentWindowId != null && windowId === currentWindowId) {
      currentWindowItems = packet.input;

      if (containerItemsDumpedForWindow !== currentWindowId) {
        containerItemsDumpedForWindow = currentWindowId;
        dumpContainerItems(currentWindowId, currentWindowItems);
      }

      if (state === State.CONTAINER_OPENED || state === State.WAIT_UI) {
        setState(
          State.WAIT_CONTAINER_CONTENT,
          "inventory_content for container window"
        );
      }
      // Attempt take as soon as we have content.
      maybeTakeDesiredSlot();
    }
  });

  // Many servers send incremental inventory_slot updates instead of a full inventory_content.
  client.on("inventory_slot", (packet) => {
    const rawWindowId = packet?.window_id;
    const windowId = normalizeWindowId(rawWindowId);
    if (windowId == null) return;

    // Window 0 is the player inventory in common Bedrock flows.
    if (!inventoryReady && windowId === 0) {
      markInventoryReady("inventory_slot (player)");
    }

    if (
      windowId === PLAYER_INVENTORY_WINDOW_ID &&
      Number.isInteger(packet?.slot)
    ) {
      if (!Array.isArray(playerInventoryItems)) playerInventoryItems = [];
      playerInventoryItems[packet.slot] = packet.item;
    }

    // Keep container items updated so manual take can work even after initial content.
    if (
      currentWindowId != null &&
      windowId === currentWindowId &&
      Number.isInteger(packet?.slot)
    ) {
      if (!Array.isArray(currentWindowItems)) currentWindowItems = [];
      currentWindowItems[packet.slot] = packet.item;

      // If the desired slot arrives late (common on scripted GUIs), take immediately.
      if (
        state === State.WAIT_CONTAINER_CONTENT &&
        !clickSent &&
        packet.slot === desiredTakeSlotIndex
      ) {
        maybeTakeDesiredSlot();
      }
    }

    // If we're waiting and getting slots for other windows, keep fallback armed.
    if (state === State.WAIT_INVENTORY_READY && !inventoryReady) {
      armInventoryReadyFallback();
    }
  });

  client.on("container_open", (packet) => {
    // packet_container_open: window_id, window_type, coordinates, runtime_entity_id
    currentWindowId = normalizeWindowId(packet.window_id);
    currentWindowType = packet.window_type;
    currentWindowItems = null;
    clickSent = false;
    containerItemsDumpedForWindow = null;
    lastUiCandidateSignature = null;
    console.log(
      `[ui] container_open windowId=${currentWindowId} windowType=${currentWindowType}`
    );
    setState(State.CONTAINER_OPENED, "container_open");
    setState(
      State.WAIT_CONTAINER_CONTENT,
      "waiting inventory_content for window"
    );
  });

  client.on("container_close", (packet) => {
    const closedId = normalizeWindowId(packet.window_id);
    if (closedId === currentWindowId) {
      console.log(`[ui] container_close windowId=${String(packet.window_id)}`);
      currentWindowId = null;
      currentWindowType = null;
      currentWindowItems = null;
      containerItemsDumpedForWindow = null;
      lastUiCandidateSignature = null;
      if (state === State.CLICK_SENT) {
        setState(State.DONE, "container closed after click");
      }
    }
  });

  client.on("modal_form_request", (packet) => {
    // DonutSMP may use forms. We do NOT auto-respond unless you explicitly want it.
    console.log(
      "[ui] modal_form_request received (server used Form UI, not container)"
    );
  });

  // Optional: show chat
  client.on("text", (packet) => {
    if (packet?.message) {
      const who = packet.source_name ? stripMinecraftFormatting(packet.source_name) : "Server";
      const message = stripMinecraftFormatting(packet.message);
      console.log(`💬 ${who}: ${message}`);
      // Re-render prompt to keep > at bottom after incoming messages
      if (rl && typeof rl.prompt === "function") {
        rl.prompt(true);
      }
    }
  });
}

function disconnectServer() {
  if (!client) {
    console.log("[boot] not connected");
    return;
  }
  // Manual disconnect disables auto reconnect.
  wantConnected = false;
  userInitiatedConnect = false; // Disable auto-reconnect
  clearReconnectTimer();
  console.log("[boot] disconnecting...");
  try {
    client.close();
  } catch {
    // ignore
  }
}

// Console control (manual override)
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("[boot] not connecting automatically. Type 'connect' to start.");
console.log(`[boot] Auto-reconnect: ${config.behavior.autoReconnect ? 'enabled' : 'disabled'}`);
setTimeout(() => rl.prompt(), 200);
rl.on("line", (line) => {
  const input = line.trim();
  if (!input) return rl.prompt();
  if (input === "exit" || input === "quit") {
    disconnectServer();
    return;
  }
  if (input === "connect") {
    connectServer();
    return rl.prompt();
  }
  if (input === "disconnect") {
    disconnectServer();
    return rl.prompt();
  }

  if (input === "slot" || input.startsWith("slot ")) {
    const n = input === "slot" ? NaN : Number(input.slice(5).trim());
    if (!Number.isInteger(n) || n < 0) {
      console.log("Usage: slot <index> (0-based)");
    } else {
      desiredTakeSlotIndex = n;
      console.log(`[cfg] desiredTakeSlotIndex=${desiredTakeSlotIndex}`);
    }
    return rl.prompt();
  }

  if (input === "take" || input.startsWith("take ")) {
    const n =
      input === "take" ? desiredTakeSlotIndex : Number(input.slice(5).trim());
    if (!Number.isInteger(n) || n < 0) {
      console.log("Usage: take <index> (0-based)");
    } else {
      desiredTakeSlotIndex = n;
      tryTakeFromOpenContainer(desiredTakeSlotIndex);
    }
    return rl.prompt();
  }
  if (input === "tpa" || input.startsWith("tpa ")) {
    const rest = input === "tpa" ? "" : input.slice(4).trim();
    const parts = rest ? rest.split(/\s+/g) : [];

    // Support: `tpa <player> slot <n>` (sets desired slot for the upcoming GUI take)
    const slotPos = parts.findIndex((p) => p.toLowerCase() === "slot");
    let player = "";
    if (slotPos >= 0) {
      player = parts.slice(0, slotPos).join(" ");
      const nRaw = parts[slotPos + 1];
      const n = Number(nRaw);
      if (Number.isInteger(n) && n >= 0) {
        desiredTakeSlotIndex = n;
        console.log(`[cfg] desiredTakeSlotIndex=${desiredTakeSlotIndex}`);
      } else {
        console.log("Usage: tpa <player> slot <index>");
      }
    } else {
      player = rest;
    }

    const cmdLine = player ? `/tpa ${player}` : TARGET_COMMAND;
    if (canSendCommands()) sendCommand(cmdLine);
    else
      console.log(`[manual] not ready to send commands yet (state=${state})`);
    return rl.prompt();
  }
  if (input.startsWith("cmd ")) {
    const cmd = input.slice(4);
    if (canSendCommands()) sendCommand(cmd);
    else
      console.log(`[manual] not ready to send commands yet (state=${state})`);
    return rl.prompt();
  }
  if (input === "state") {
    console.log({
      state,
      connected: Boolean(client),
      availableCommandsSeen,
      inventoryReady,
      inventoryReadyReason,
      currentWindowId,
      clickSent,
      commandSent,
      autoCommandSent,
      commandSentCount,
      desiredTakeSlotIndex,
    });
    return rl.prompt();
  }
  console.log(
    "Commands: connect | disconnect | state | tpa <player> [slot <n>] | slot <n> | take [n] | cmd <...> | exit"
  );
  rl.prompt();
});

process.on("SIGINT", () => {
  console.log("\n[exit] shutting down");
  disconnectServer();
  process.exit(0);
});