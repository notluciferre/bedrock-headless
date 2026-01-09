/**
 * SIMPLE BEDROCK CLIENT
 * Commands: connect, disconnect, exec <command>
 */

import fs from "fs";
import readline from "readline";
import bedrock from "bedrock-protocol";

// Load config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

let client = null;
let connected = false;
let pingInterval = null;
let lastPingTime = null;
let lastPongTime = null;
let autoReconnectEnabled = false;
let reconnecting = false;
let rl = null;

// Logger functions
function getTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function log(level, message) {
    if (rl) {
        // Clear current line and move cursor to start
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
    }
    
    const timestamp = getTimestamp();
    console.log(`[${level}] ${timestamp} - ${message}`);
    
    if (rl) {
        // Redraw prompt
        rl.prompt(true);
    }
}

function logInfo(message) {
    log('INFO', message);
}

function logWarn(message) {
    log('WARN', message);
}

function logError(message) {
    log('ERROR', message);
}

function logChat(message) {
    log('CHAT', message);
}

function logPing(message) {
    log('PING', message);
}

// Ping timeout checker with auto-reconnect
function startPingMonitor() {
    if (pingInterval) {
        clearInterval(pingInterval);
    }

    // Reset ping times
    lastPingTime = Date.now();
    lastPongTime = Date.now();

    pingInterval = setInterval(() => {
        if (!connected || !client) return;

        const now = Date.now();
        const timeSinceLastPong = now - lastPongTime;

        // Check if server is not responding
        if (timeSinceLastPong > config.ping.timeoutMs) {
            logWarn(`Timeout detected (${timeSinceLastPong}ms since last response)`);
            
            if (autoReconnectEnabled && config.ping.autoReconnect) {
                logInfo("Auto-reconnect triggered");
                reconnecting = true;
                disconnect();
                
                setTimeout(() => {
                    logInfo("Attempting to reconnect...");
                    connect();
                }, config.ping.reconnectDelayMs || 3000);
            } else {
                disconnect();
            }
            return;
        }

        // Send ping command
        const pingCmd = config.ping.command || "ping";
        logPing(`Sending /${pingCmd}...`);

    }, config.ping.intervalMs);
}

function stopPingMonitor() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

async function connect() {
    if (connected) {
        console.log("[connect] Already connected");
        return;
    }logWarn("Already connected");
        return;
    }

    try {
        logInfo(`Client({
            host: config.server.ip,
            port: config.server.port,
            username: "Player" + Math.floor(Math.random() * 1000),
            offline: false, // Set to false for Xbox authentication
            skipPing: true,
            keepAlive: true,
        });

        // Connection handlers
        client.on("spawn", () => {
            connected = true;
            lastPingTime = Date.now();
            lastPongTime = Date.now();

            if (reconnecting) {
                console.log("[reconnect] ✓ Reconnected successfully!");
                reconnecting = false;
            } else {
                console.log("[connect] ✓ Connected!");
            }

            // Enable auto-reconnect after first successful connect
            autoReconnectEnabled = true;
            startPingMonitor();
        });

        client.on("text", (packet) => {
            if (packet?.message) {
                const msg = packet.message.toLowerCase();
                logChat(packet.message);

                // Update last pong time when we receive any text message
                // (including potential ping responses)
                lastPongTime = Date.now();

                // Also check for common ping response patterns
                if (msg.includes("pong") || msg.includes("ms") || msg.includes("ping")) {
                    logPing("Pong received");
                }
            }

            // Show all text packet data (for debugging login links)
            if (packet?.type === "translation" && packet?.parameters) {
                logInfo(`Translation: ${JSON.stringify(packet.parameters)}`);
            }
        });

        // Handle server settings packet (may contain auth info)
        client.on("server_settings_response", (packet) => {
            logInfo(`Server settings: ${JSON.stringify(packet)}`);
        });

        // Handle modal form (may contain login link)
        client.on("modal_form_request", (packet) => {
            logInfo(`Modal form: ${JSON.stringify(packet)}`);
        });

        client.on("disconnect", (packet) => {
            logWarn(`Disconnected: ${packet?.message || "Connection closed"}`);
            handleDisconnect();
        });

        client.on("kick", (packet) => {
            logError(`Kicked: ${packet?.message || "Kicked from server"}`);
            handleDisconnect();
        });

        client.on("close", () => {
            logWarn("Connection closed");
            handleDisconnect();
        });

        client.on("error", (err) => {
            const msg = String(err?.message || err);
            // Suppress harmless decode errors from DonutSMP custom packets
            if (msg.includes('Read error') || msg.includes('Invalid tag')) {
                // Silently ignore - these are expected with custom server packets
                return;
            }
            logError(msg);
        });

        // Suppress internal bedrock-protocol decoder errors
        if (client._client?.serializer) {
            const originalEmit = client._client.serializer.emit?.bind(client._client.serializer);
            if (originalEmit) {
                client._client.serializer.emit = function(event, ...args) {
                    if (event === 'error') {
                        const err = args[0];
                        const msg = String(err?.message || err);
                        if (msg.includes('Read error') || msg.includes('Invalid tag')) {
                            return; // Suppress log spam
                        }
                    }
                    return originalEmit(event, ...args);
                };
            }
        }

        // Update pong time on any packet (server is responding)
        client.on("packet", () => {
            lastPongTime = Date.now();
        });

    } catch (error) {
        logError(`Connection failed: ${error.message}`);
        connected = false;
        client = null;
    }
}

function handleDisconnect() {
    if (!connected) return;
    
    connected = false;
    stopPingMonitor();
    client = null;
    
    if (!reconnecting) {
        logWarn("Disconnected from server");
        
        // Trigger auto-reconnect if enabled
        if (autoReconnectEnabled && config.ping.autoReconnect) {
            logInfo("Scheduled reconnect...");
            reconnecting = true;
            setTimeout(() => {
                logInfo("Attempting to reconnect...");
                connect();
            }, config.ping.reconnectDelayMs || 3000);
        }
    }
}

function disconnect() {
    if (!connected && !reconnecting) {
        logWarn("Not connected");
        return;
    }

    logInfo("Disconnecting...");
    // Disable auto-reconnect when user manually disconnects
    if (!reconnecting) {
        autoReconnectEnabled = false;
    }

    stopPingMonitor();

    if (client) {
        try {
            client.close();
        } catch (e) {
            // Ignore close errors
        }
        client = null;
    }

    connected = false;
}

function execCommand(command) {
    if (!connected || !client) {
        console.log("[exec] Not connected");
        logWarn("Not connected");
        return;
    }

    const cmd = command.startsWith("/") ? command : `/${command}`;
    
    try {
        client.write("command_request", {
            command: cmd,
            origin: {
                type: "player",
                uuid: "",
                request_id: "",
                player_entity_id: 0,
            },
            internal: false,
            version: "52",
        });
        
        logInfo(`Sent: ${cmd}`);
    } catch (error) {
        logError(`Command error: ${error.message}`);
    }
}

// Console interface
rl = readline.createInterface({
});

console.log("=".repeat(60));
console.log("BEDROCK HEADLESS CLIENT");
console.log("=".repeat(60));
console.log("Commands:");
console.log("  connect              - Connect to server");
console.log("  disconnect           - Disconnect from server");
console.log("  exec <command>       - Execute a command");
console.log("  exit                 - Exit program");
console.log("=".repeat(60));
console.log(`Auto-reconnect: ${config.ping.autoReconnect ? 'enabled' : 'disabled'}`);
console.log(`Ping interval: ${config.ping.intervalMs}ms`);
console.log(`Ping timeout: ${config.ping.timeoutMs}ms`);
console.log("=".repeat(60));

setTimeout(() => rl.prompt(), 200);

rl.on("line", (line) => {
    const input = line.trim();

    if (!input) {
        rl.prompt();
        return;
    }

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // Exit
    if (cmd === "exit" || cmd === "quit") {
        console.log("[exit] Shutting down...");
        disconnect();
        process.exit(0);
        logInfo("Shutting down...");
        disconnect();
        process.exit(0);
        return;
    }

    // Connect
    if (cmd === "connect") {
        connect().then(() => rl.prompt());
        return;
    }

    // Disconnect
    if (cmd === "disconnect") {
        disconnect();
        rl.prompt();
        return;
    }

    // Execute command
    if (cmd === "exec") {
        const command = parts.slice(1).join(" ");
        if (!command) {
            logWarn("Usage: exec <command>");
        } else {
            execCommand(command);
        }
        rl.prompt();
        return;
    }

    logWarn("Unknown command. Available
// Graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[exit] Shutting down...");
    disconnect();
    process.exit(0);
});logInfo("Shutting down...");
    disconnect();
    process.exit(0);
});

process.on("SIGTERM", () => {
    logInfo("