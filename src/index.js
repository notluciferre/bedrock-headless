/**
 * MAIN ENTRY POINT
 * Manual command execution via console with auto-reconnect and OrderDropper
 */

import fs from "fs";
import readline from "readline";
import { Logger } from "./Logger.js";
import { StateMachine, ClientState } from "./StateMachine.js";
import { BedrockClient } from "./BedrockClient.js";
import { CommandHandler } from "./CommandHandler.js";
import { GUIHandler } from "./GUIHandler.js";
import { DisconnectDetector } from "./DisconnectDetector.js";
import { OrderDropper } from "./OrderDropper.js";
import { stripMinecraftFormatting } from "./utils.js";

// Known item IDs for easy lookup
const KNOWN_ITEMS = {
    amethyst: { id: 582, name: "amethyst_block" },
    amethyst_block: { id: 582, name: "amethyst_block" },
    redstone: { id: 152, name: "redstone_block" },
    redstone_block: { id: 152, name: "redstone_block" },
    diamond: { id: 57, name: "diamond_block" },
    diamond_block: { id: 57, name: "diamond_block" },
    gold: { id: 41, name: "gold_block" },
    gold_block: { id: 41, name: "gold_block" },
    iron: { id: 42, name: "iron_block" },
    iron_block: { id: 42, name: "iron_block" },
    emerald: { id: 133, name: "emerald_block" },
    emerald_block: { id: 133, name: "emerald_block" },
    lapis: { id: 22, name: "lapis_block" },
    lapis_block: { id: 22, name: "lapis_block" },
};

class BedrockAFKClient {
    constructor(configPath = "./config.json") {
        // Load config
        this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));

        // Initialize components
        this.logger = new Logger(this.config);
        this.sm = new StateMachine(this.logger);
        this.bedrockClient = new BedrockClient(this.config, this.sm, this.logger);
        this.commandHandler = null;
        this.guiHandler = null;
        this.disconnectDetector = null;
        this.orderDropper = null;
        this.connected = false;
        this.desiredSlotIndex = this.config.behavior.slotIndex || 16;

        // Auto-reconnect state
        this.userInitiatedConnect = false; // Track if user used 'connect' command
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectTimer = null;

        // Target item settings
        this.targetItemId = this.config.behavior.targetItemId || null;
        this.targetItemName = this.config.behavior.targetItemName || null;

        // Readline reference for prompt refresh
        this.rl = null;
    }

    setTargetItem(itemArg) {
        // Check if it's a number (direct ID)
        const asNumber = Number(itemArg);
        if (Number.isInteger(asNumber) && asNumber > 0) {
            this.targetItemId = asNumber;
            this.targetItemName = null;
            console.log(`[cfg] Target item set to id=${this.targetItemId}`);
            return true;
        }

        // Check if it's a known item name
        const lowerArg = itemArg.toLowerCase();
        if (KNOWN_ITEMS[lowerArg]) {
            this.targetItemId = KNOWN_ITEMS[lowerArg].id;
            this.targetItemName = KNOWN_ITEMS[lowerArg].name;
            console.log(
                `[cfg] Target item set to ${this.targetItemName} (id=${this.targetItemId})`
            );
            return true;
        }

        console.log(`[cfg] Unknown item: ${itemArg}`);
        console.log(`[cfg] Known items: ${Object.keys(KNOWN_ITEMS).join(", ")}`);
        console.log(`[cfg] Or use a numeric ID directly`);
        return false;
    }

    async connect(isReconnect = false) {
        if (this.connected) {
            console.log("[boot] already connected");
            return;
        }

        // Track user-initiated connect for auto-reconnect
        if (!isReconnect) {
            this.userInitiatedConnect = true;
            this.reconnectAttempts = 0;
        }

        try {
            console.log("=".repeat(60));
            console.log("BEDROCK AFK CLIENT - DonutSMP");
            console.log("=".repeat(60));
            console.log(
                `Target: ${this.config.server.host}:${this.config.server.port}`
            );
            console.log(`Mode: ${this.config.mode || "headless"}`);
            console.log(`Slot: ${this.desiredSlotIndex}`);
            console.log(`Auto-reconnect: ${this.config.behavior.autoReconnect ? 'enabled' : 'disabled'}`);
            console.log("=".repeat(60));

            // Connect to server
            await this.bedrockClient.connect();
            this.connected = true;
            this.reconnectAttempts = 0; // Reset on successful connect

            const client = this.bedrockClient.getClient();

            // Initialize handlers
            this.commandHandler = new CommandHandler(
                client,
                this.sm,
                this.logger,
                this.config
            );

            this.guiHandler = new GUIHandler(
                client,
                this.sm,
                this.logger,
                this.config
            );

            // Setup GUI handlers
            this.guiHandler.setupHandlers();

            // Setup text handler for chat messages (with formatting stripped)
            this.setupTextHandler(client);

            // Setup disconnect detection
            this.setupDisconnectHandling(client);

            // Initialize OrderDropper
            this.orderDropper = new OrderDropper(
                client,
                this.commandHandler,
                this.sm,
                this.logger,
                this.config
            );

            this.connected = true;
            this.logger.info("✓ Connected! Waiting for ready state...");
            this.logger.info('Use "cmd <command>" to send commands manually');
            this.logger.info('Use "dropper start" to start OrderDropper');
        } catch (error) {
            this.logger.error(`Failed to connect: ${error.message}`);
            this.connected = false;

            // Auto-reconnect on failure if enabled
            if (this.userInitiatedConnect && this.config.behavior.autoReconnect) {
                this.scheduleReconnect('connection_failed');
            }
        }
    }

    /**
     * Setup text packet handler with formatting stripped
     */
    setupTextHandler(client) {
        client.on('text', (packet) => {
            if (packet?.message) {
                // Strip Minecraft formatting codes
                const cleanMessage = stripMinecraftFormatting(packet.message);
                const who = packet.source_name ? stripMinecraftFormatting(packet.source_name) : 'Server';

                console.log(`💬 ${who}: ${cleanMessage}`);

                // Check for ping response (for disconnect detector)
                if (this.disconnectDetector && cleanMessage.toLowerCase().includes('pong')) {
                    this.disconnectDetector.onPongReceived(cleanMessage);
                }

                // Re-render prompt to keep > at bottom
                if (this.rl && typeof this.rl.prompt === 'function') {
                    this.rl.prompt(true);
                }
            }
        });
    }

    /**
     * Setup disconnect detection and auto-reconnect
     */
    setupDisconnectHandling(client) {
        // Initialize disconnect detector
        this.disconnectDetector = new DisconnectDetector(
            client,
            this.commandHandler,
            this.logger,
            this.config
        );

        // Set callback for disconnect detection
        this.disconnectDetector.setDisconnectCallback((reason) => {
            this.handleDisconnect(reason);
        });

        // Handle protocol-level disconnect
        client.on('disconnect', (packet) => {
            const reason = packet?.message ? stripMinecraftFormatting(packet.message) : 'unknown';
            this.logger.warn(`Disconnected from server: ${reason}`);
            this.handleDisconnect(`server_disconnect: ${reason}`);
        });

        client.on('kick', (packet) => {
            const reason = packet?.message ? stripMinecraftFormatting(packet.message) : 'unknown';
            this.logger.error(`Kicked from server: ${reason}`);
            this.handleDisconnect(`kicked: ${reason}`);
        });

        client.on('close', () => {
            this.logger.warn('Connection closed');
            this.handleDisconnect('connection_closed');
        });

        client.on('error', (err) => {
            const msg = String(err?.message || err);
            // Ignore harmless decode errors from DonutSMP
            if (msg.includes('Read error') || msg.includes('Invalid tag')) {
                return;
            }
            this.logger.error(`Client error: ${msg}`);
            this.handleDisconnect(`error: ${msg}`);
        });

        // Start disconnect detector after a delay (wait for ready state)
        setTimeout(() => {
            if (this.connected && this.disconnectDetector) {
                this.disconnectDetector.start();
            }
        }, 30000);
    }

    /**
     * Handle disconnect event
     */
    handleDisconnect(reason) {
        if (!this.connected) return; // Already disconnected

        this.connected = false;

        // Stop detector
        if (this.disconnectDetector) {
            this.disconnectDetector.stop();
        }

        // Stop order dropper if running
        if (this.orderDropper) {
            this.orderDropper.stop();
        }

        // Cleanup
        this.commandHandler = null;
        this.guiHandler = null;
        this.disconnectDetector = null;
        this.orderDropper = null;

        this.logger.warn(`Disconnect handled: ${reason}`);

        // Auto-reconnect if enabled and user initiated connect
        if (this.userInitiatedConnect && this.config.behavior.autoReconnect) {
            this.scheduleReconnect(reason);
        }
    }

    /**
     * Schedule auto-reconnect
     */
    scheduleReconnect(reason) {
        if (!this.userInitiatedConnect) {
            console.log('[reconnect] Disabled - user must connect manually');
            return;
        }

        if (!this.config.behavior.autoReconnect) {
            console.log('[reconnect] Disabled in config');
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log(`[reconnect] Max attempts (${this.maxReconnectAttempts}) reached, giving up`);
            this.userInitiatedConnect = false;
            return;
        }

        // Clear any existing timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;

        // Exponential backoff with jitter
        const baseDelay = this.config.behavior.reconnectDelayMs || 5000;
        const backoff = Math.min(baseDelay * Math.pow(1.5, this.reconnectAttempts - 1), 60000);
        const jitter = Math.random() * 1000;
        const delay = Math.floor(backoff + jitter);

        console.log(`[reconnect] Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms (reason: ${reason})`);

        this.reconnectTimer = setTimeout(async() => {
            console.log('[reconnect] Attempting to reconnect...');
            try {
                // Reset bedrock client
                this.bedrockClient = new BedrockClient(this.config, this.sm, this.logger);
                this.sm.reset();
                await this.connect(true); // isReconnect = true
            } catch (err) {
                console.log(`[reconnect] Failed: ${err.message}`);
                // Will trigger another reconnect attempt via handleDisconnect
            }
        }, delay);
    }

    disconnect() {
        if (!this.connected && !this.reconnectTimer) {
            console.log("[boot] not connected");
            return;
        }

        // Cancel any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Disable auto-reconnect when user manually disconnects
        this.userInitiatedConnect = false;

        this.logger.info("Disconnecting...");

        // Stop detector
        if (this.disconnectDetector) {
            this.disconnectDetector.stop();
        }

        // Stop order dropper
        if (this.orderDropper) {
            this.orderDropper.stop();
        }

        this.bedrockClient.disconnect();
        this.connected = false;
        this.commandHandler = null;
        this.guiHandler = null;
        this.disconnectDetector = null;
        this.orderDropper = null;
    }

    canSendCommands() {
        return this.connected && this.commandHandler && this.sm.canSendCommand();
    }

    sendCommand(commandLine) {
        if (!this.canSendCommands()) {
            console.log(
                `[manual] not ready to send commands yet (state=${this.sm.state})`
            );
            return false;
        }

        return this.commandHandler.sendCommand(commandLine);
    }

    getState() {
        return {
            connected: this.connected,
            state: this.sm.state,
            commandsAvailable: this.sm.stateData.commandsAvailable,
            inventoryReady: this.sm.stateData.inventoryReady,
            windowId: this.sm.stateData.windowId,
            slotIndex: this.config.behavior.slotIndex,
            targetItemId: this.targetItemId,
            targetItemName: this.targetItemName,
            reconnectAttempts: this.reconnectAttempts,
            userInitiatedConnect: this.userInitiatedConnect,
            orderDropper: this.orderDropper ? this.orderDropper.getStatus() : null,
        };
    }

    getTargetInfo() {
        return {
            id: this.targetItemId,
            name: this.targetItemName,
        };
    }

    // OrderDropper controls
    startOrderDropper() {
        if (!this.orderDropper) {
            console.log('[dropper] Not initialized - connect first');
            return;
        }
        if (!this.canSendCommands()) {
            console.log('[dropper] Cannot start - not ready to send commands');
            return;
        }
        this.orderDropper.start();
    }

    stopOrderDropper() {
        if (this.orderDropper) {
            this.orderDropper.stop();
        }
    }

    getDropperStatus() {
        if (!this.orderDropper) {
            return { running: false, message: 'Not initialized' };
        }
        return this.orderDropper.getStatus();
    }
}

// Initialize client
const client = new BedrockAFKClient("./config.json");

// Console interface (manual control)
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
});

// Pass readline reference to client for prompt refresh
client.rl = rl;

console.log("[boot] DonutSMP Client - Manual Mode");
console.log("[boot] Commands:");
console.log("  connect | disconnect | state | cmd <command>");
console.log("  dropper start | dropper stop | dropper status");
console.log("  afk [take <item>] | target <item> | order | tpa [player] | slot <n> | exit");
console.log(`[boot] Auto-reconnect: ${client.config.behavior.autoReconnect ? 'enabled' : 'disabled'}`);
console.log('[boot] Type "connect" to start');

setTimeout(() => rl.prompt(), 200);

rl.on("line", (line) => {
    const input = line.trim();

    if (!input) {
        rl.prompt();
        return;
    }

    // Exit
    if (input === "exit" || input === "quit") {
        console.log("[exit] shutting down");
        client.disconnect();
        process.exit(0);
        return;
    }

    // Connect
    if (input === "connect") {
        client.connect().then(() => rl.prompt());
        return;
    }

    // Disconnect
    if (input === "disconnect") {
        client.disconnect();
        rl.prompt();
        return;
    }

    // State
    if (input === "state") {
        console.log(client.getState());
        rl.prompt();
        return;
    }

    // OrderDropper commands
    if (input === "dropper start") {
        client.startOrderDropper();
        rl.prompt();
        return;
    }

    if (input === "dropper stop") {
        client.stopOrderDropper();
        rl.prompt();
        return;
    }

    if (input === "dropper status") {
        console.log(client.getDropperStatus());
        rl.prompt();
        return;
    }

    // Set slot index
    if (input === "slot" || input.startsWith("slot ")) {
        const n = input === "slot" ? NaN : Number(input.slice(5).trim());
        if (!Number.isInteger(n) || n < 0) {
            console.log("Usage: slot <index> (0-based)");
        } else {
            client.config.behavior.slotIndex = n;
            console.log(`[cfg] slotIndex=${n}`);
        }
        rl.prompt();
        return;
    }

    // AFK command with optional take argument
    // Usage: afk [take <item>]
    // Examples: afk, afk take amethyst, afk take 582
    if (input === "afk" || input.startsWith("afk ")) {
        const rest = input === "afk" ? "" : input.slice(4).trim();
        const parts = rest ? rest.split(/\s+/g) : [];

        // Check for 'take' argument
        const takePos = parts.findIndex((p) => p.toLowerCase() === "take");
        if (takePos >= 0) {
            const itemArg = parts[takePos + 1];
            if (itemArg) {
                client.setTargetItem(itemArg);
            } else {
                console.log("Usage: afk take <item_name|item_id>");
                console.log("Examples: afk take amethyst, afk take 582");
                rl.prompt();
                return;
            }
        }

        // Send the /afk command
        if (client.canSendCommands()) {
            const target = client.getTargetInfo();
            console.log(
                `[afk] Sending /afk (target: ${
          target.name || target.id || "auto-detect unique"
        })`
            );
            client.sendCommand("/afk");
        } else {
            console.log(
                `[manual] not ready to send commands yet (state=${client.sm.state})`
            );
        }
        rl.prompt();
        return;
    }

    // Set target item without sending command
    if (input === "target" || input.startsWith("target ")) {
        const arg = input === "target" ? "" : input.slice(7).trim();
        if (!arg) {
            const target = client.getTargetInfo();
            console.log(
                `[cfg] Current target: ${target.name || "(none)"} (id=${
          target.id || "auto"
        })`
            );
            console.log("Usage: target <item_name|item_id>");
            console.log("Examples: target amethyst, target 582");
        } else {
            client.setTargetItem(arg);
        }
        rl.prompt();
        return;
    }

    // Send command
    if (input.startsWith("cmd ")) {
        const cmd = input.slice(4).trim();
        if (!cmd) {
            console.log("Usage: cmd <command>");
        } else {
            client.sendCommand(cmd);
        }
        rl.prompt();
        return;
    }

    // Shortcut for /tpa
    if (input === "tpa" || input.startsWith("tpa ")) {
        const rest = input === "tpa" ? "" : input.slice(4).trim();
        const cmdLine = rest ? `/tpa ${rest}` : "/tpa";
        client.sendCommand(cmdLine);
        rl.prompt();
        return;
    }

    // Shortcut for /order
    if (input === "order" || input.startsWith("order ")) {
        const rest = input === "order" ? "" : input.slice(6).trim();
        const cmdLine = rest ? `/order ${rest}` : "/order";
        client.sendCommand(cmdLine);
        rl.prompt();
        return;
    }

    console.log("Commands:");
    console.log("  connect | disconnect | state | cmd <command>");
    console.log("  dropper start | dropper stop | dropper status");
    console.log("  afk [take <item>] | target <item> | order | tpa [player] | slot <n> | exit");
    console.log("Items: amethyst, redstone, diamond, gold, iron, emerald, lapis (or numeric ID)");
    rl.prompt();
});

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[exit] shutting down");
    client.disconnect();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n[exit] shutting down");
    client.disconnect();
    process.exit(0);
});