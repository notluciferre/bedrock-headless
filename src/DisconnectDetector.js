/**
 * DISCONNECT DETECTOR
 * Mendeteksi disconnect dengan mengirim /ping command
 * dan menunggu response dari server dalam timeout tertentu
 */

import { ClientState } from './StateMachine.js';

export class DisconnectDetector {
    constructor(client, commandHandler, logger, config) {
        this.client = client;
        this.commandHandler = commandHandler;
        this.logger = logger;
        this.config = config;

        this.pingTimer = null;
        this.timeoutTimer = null;
        this.lastPingTime = null;
        this.awaitingPong = false;
        this.isRunning = false;

        // Callbacks
        this.onDisconnectDetected = null;
    }

    /**
     * Start the ping-based disconnect detector
     */
    start() {
        if (this.isRunning) {
            this.logger.warn('[ping] Detector already running');
            return;
        }

        this.isRunning = true;
        const intervalMs = this.config.behavior?.pingIntervalMs || 30000;

        this.logger.info(`[ping] Starting disconnect detector (interval: ${intervalMs}ms)`);

        // Schedule first ping after interval
        this.schedulePing(intervalMs);
    }

    /**
     * Stop the detector
     */
    stop() {
        this.isRunning = false;
        this.clearTimers();
        this.logger.info('[ping] Disconnect detector stopped');
    }

    /**
     * Schedule the next ping
     */
    schedulePing(delayMs) {
        this.clearTimers();

        if (!this.isRunning) return;

        this.pingTimer = setTimeout(() => {
            this.sendPing();
        }, delayMs);
    }

    /**
     * Send /ping command and start timeout
     */
    sendPing() {
        if (!this.isRunning) return;

        // Check if command handler is ready
        if (!this.commandHandler) {
            this.logger.warn('[ping] Command handler not available, rescheduling...');
            this.schedulePing(5000);
            return;
        }

        const timeoutMs = this.config.behavior?.pingTimeoutMs || 15000;

        this.logger.info('[ping] Sending /ping to detect connection status...');
        this.lastPingTime = Date.now();
        this.awaitingPong = true;

        // Send /ping command
        try {
            this.commandHandler.sendCommand('/ping');
        } catch (err) {
            this.logger.error(`[ping] Failed to send ping: ${err.message}`);
            this.handleDisconnect('ping_send_failed');
            return;
        }

        // Start timeout timer
        this.timeoutTimer = setTimeout(() => {
            if (this.awaitingPong) {
                this.logger.error(`[ping] No response within ${timeoutMs}ms - connection lost!`);
                this.handleDisconnect('ping_timeout');
            }
        }, timeoutMs);
    }

    /**
     * Called when we receive a response (text packet with ping info)
     * This should be triggered from text packet handler
     */
    onPongReceived(message) {
        if (!this.awaitingPong) return;

        // Check if message contains ping response
        // Server typically responds with "Your ping is Xms"
        if (message && (message.includes('ping') || message.includes('ms'))) {
            const latency = Date.now() - this.lastPingTime;
            this.logger.info(`[ping] Pong received! Latency: ${latency}ms`);

            this.awaitingPong = false;
            this.clearTimeoutTimer();

            // Schedule next ping
            const intervalMs = this.config.behavior?.pingIntervalMs || 30000;
            this.schedulePing(intervalMs);
        }
    }

    /**
     * Handle detected disconnect
     */
    handleDisconnect(reason) {
        this.awaitingPong = false;
        this.clearTimers();

        this.logger.error(`[ping] Disconnect detected: ${reason}`);

        if (this.onDisconnectDetected) {
            this.onDisconnectDetected(reason);
        }
    }

    /**
     * Clear all timers
     */
    clearTimers() {
        this.clearPingTimer();
        this.clearTimeoutTimer();
    }

    clearPingTimer() {
        if (this.pingTimer) {
            clearTimeout(this.pingTimer);
            this.pingTimer = null;
        }
    }

    clearTimeoutTimer() {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }

    /**
     * Set callback for disconnect detection
     */
    setDisconnectCallback(callback) {
        this.onDisconnectDetected = callback;
    }
}