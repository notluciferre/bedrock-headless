/**
 * ORDER DROPPER
 * Inspired by Glazed client OrderDropper feature for DonutSMP
 * 
 * Flow:
 * 1. Send /order command to open order GUI
 * 2. Wait for container_open + inventory_content
 * 3. Click target slot to receive items
 * 4. Wait for container_close
 * 5. Drop items from hotbar slots
 * 6. Repeat cycle
 * 
 * Bedrock Protocol packets used:
 * - command_request: Send /order command
 * - container_open: Server opens order GUI
 * - inventory_content: GUI slots data
 * - inventory_transaction: Click slot to take items
 * - container_close: Close GUI after taking
 * - player_action: Drop item (ACTION_DROP_ITEM = 4)
 * - mob_equipment: Select hotbar slot before dropping
 */

import { ClientState } from './StateMachine.js';

export class OrderDropper {
    constructor(client, commandHandler, stateMachine, logger, config) {
        this.client = client;
        this.commandHandler = commandHandler;
        this.sm = stateMachine;
        this.logger = logger;
        this.config = config;

        // State
        this.isRunning = false;
        this.cycleCount = 0;
        this.currentPhase = 'idle'; // idle, ordering, waiting_gui, taking, dropping

        // Timing
        this.dropDelayMs = config.orderDropper?.dropDelayMs || 100;
        this.cycleDelayMs = config.orderDropper?.cycleDelayMs || 2000;
        this.maxCycles = config.orderDropper?.maxCycles || 100;
        this.targetSlots = config.orderDropper?.targetSlots || [0, 1, 2, 3, 4, 5, 6, 7, 8];
        this.orderCommand = config.orderDropper?.orderCommand || '/order';

        // Container data
        this.windowId = null;
        this.containerSlots = [];

        // Callbacks
        this.onCycleComplete = null;
        this.onError = null;
    }

    /**
     * Start the order dropper loop
     */
    start() {
        if (this.isRunning) {
            this.logger.warn('[dropper] Already running');
            return;
        }

        this.isRunning = true;
        this.cycleCount = 0;
        this.currentPhase = 'idle';

        this.logger.info('[dropper] Starting Order Dropper...');
        this.logger.info(`[dropper] Order command: ${this.orderCommand}`);
        this.logger.info(`[dropper] Target slots: ${this.targetSlots.join(', ')}`);
        this.logger.info(`[dropper] Max cycles: ${this.maxCycles}`);

        // Setup packet handlers
        this.setupHandlers();

        // Start first cycle
        this.startCycle();
    }

    /**
     * Stop the order dropper
     */
    stop() {
        this.isRunning = false;
        this.currentPhase = 'idle';
        this.logger.info(`[dropper] Stopped after ${this.cycleCount} cycles`);
    }

    /**
     * Setup packet handlers for container events
     */
    setupHandlers() {
        // Container opened - GUI received
        this.containerOpenHandler = (packet) => {
            if (!this.isRunning || this.currentPhase !== 'waiting_gui') return;

            this.windowId = packet.window_id;
            this.logger.info(`[dropper] Container opened: windowId=${this.windowId}`);
        };

        // Inventory content - slots received
        this.inventoryContentHandler = (packet) => {
            if (!this.isRunning) return;
            if (packet.window_id !== this.windowId) return;

            this.containerSlots = packet.input || [];
            this.logger.info(`[dropper] Received ${this.containerSlots.length} slots`);

            if (this.currentPhase === 'waiting_gui') {
                this.currentPhase = 'taking';
                this.takeFromContainer();
            }
        };

        // Container closed
        this.containerCloseHandler = (packet) => {
            if (!this.isRunning) return;
            if (packet.window_id !== this.windowId) return;

            this.logger.info('[dropper] Container closed');
            this.windowId = null;

            if (this.currentPhase === 'taking') {
                this.currentPhase = 'dropping';
                this.dropItems();
            }
        };

        // Attach handlers
        this.client.on('container_open', this.containerOpenHandler);
        this.client.on('inventory_content', this.inventoryContentHandler);
        this.client.on('container_close', this.containerCloseHandler);
    }

    /**
     * Remove packet handlers
     */
    removeHandlers() {
        if (this.containerOpenHandler) {
            this.client.removeListener('container_open', this.containerOpenHandler);
        }
        if (this.inventoryContentHandler) {
            this.client.removeListener('inventory_content', this.inventoryContentHandler);
        }
        if (this.containerCloseHandler) {
            this.client.removeListener('container_close', this.containerCloseHandler);
        }
    }

    /**
     * Start a new cycle
     */
    startCycle() {
        if (!this.isRunning) return;

        if (this.cycleCount >= this.maxCycles) {
            this.logger.info(`[dropper] Max cycles (${this.maxCycles}) reached, stopping`);
            this.stop();
            return;
        }

        this.cycleCount++;
        this.logger.info(`[dropper] === Cycle ${this.cycleCount}/${this.maxCycles} ===`);

        this.currentPhase = 'ordering';
        this.sendOrderCommand();
    }

    /**
     * Send /order command
     */
    sendOrderCommand() {
        if (!this.isRunning) return;

        this.logger.info(`[dropper] Sending: ${this.orderCommand}`);

        try {
            // Send command using command_request packet
            this.commandHandler.sendCommand(this.orderCommand);
            this.currentPhase = 'waiting_gui';

            // Timeout if GUI doesn't open
            setTimeout(() => {
                if (this.currentPhase === 'waiting_gui') {
                    this.logger.warn('[dropper] GUI timeout, retrying cycle...');
                    this.scheduleNextCycle();
                }
            }, this.config.behavior?.guiTimeoutMs || 10000);

        } catch (err) {
            this.logger.error(`[dropper] Failed to send order: ${err.message}`);
            this.scheduleNextCycle();
        }
    }

    /**
     * Take items from container using inventory_transaction
     */
    takeFromContainer() {
        if (!this.isRunning || !this.windowId) return;

        const slotIndex = this.config.behavior?.slotIndex || 16;
        this.logger.info(`[dropper] Taking from slot ${slotIndex}`);

        // Build inventory transaction to click slot
        // This is similar to how Glazed clicks slots in the order GUI
        const transaction = {
            legacy: {
                legacy_request_id: 0
            },
            transaction_type: 'normal',
            actions: [{
                source_type: 'container',
                inventory_id: this.windowId,
                slot: slotIndex,
                old_item: { network_id: 0 },
                new_item: { network_id: 0 }
            }]
        };

        try {
            this.client.write('inventory_transaction', { transaction });
            this.logger.info(`[dropper] Clicked slot ${slotIndex}`);
        } catch (err) {
            this.logger.error(`[dropper] Failed to click slot: ${err.message}`);
        }

        // Wait for container to close, then drop
        setTimeout(() => {
            if (this.currentPhase === 'taking') {
                // Force close if server didn't close
                this.closeContainer();
            }
        }, 2000);
    }

    /**
     * Close container manually
     */
    closeContainer() {
        if (!this.windowId) return;

        try {
            this.client.write('container_close', {
                window_id: this.windowId,
                window_type: 0,
                server: false
            });
        } catch (err) {
            this.logger.error(`[dropper] Failed to close container: ${err.message}`);
        }

        this.windowId = null;
        this.currentPhase = 'dropping';
        this.dropItems();
    }

    /**
     * Drop items from hotbar slots
     * Uses player_action packet with ACTION_DROP_ITEM
     */
    async dropItems() {
        if (!this.isRunning) return;

        this.logger.info(`[dropper] Dropping items from slots: ${this.targetSlots.join(', ')}`);

        for (const slot of this.targetSlots) {
            if (!this.isRunning) break;

            await this.dropSlot(slot);
            await this.sleep(this.dropDelayMs);
        }

        this.logger.info('[dropper] Drop sequence complete');
        this.scheduleNextCycle();
    }

    /**
     * Drop item from a specific hotbar slot
     * 
     * Bedrock Protocol:
     * 1. mob_equipment to select slot
     * 2. player_action with ACTION_DROP_ITEM (4) or ACTION_DROP_STACK (5)
     */
    async dropSlot(slot) {
        try {
            // First, select the hotbar slot using mob_equipment
            // Hotbar slots are 0-8, inventory slots are 9-35
            this.client.write('mob_equipment', {
                runtime_entity_id: 0n, // Will be filled by protocol
                item: { network_id: 0 },
                slot: slot,
                selected_slot: slot,
                window_id: 0 // Player inventory
            });

            await this.sleep(50);

            // Then drop the item using player_action
            // ACTION_DROP_ITEM = 4, ACTION_DROP_STACK = 5
            this.client.write('player_action', {
                runtime_entity_id: 0n,
                action: 5, // DROP_STACK - drop entire stack
                position: { x: 0, y: 0, z: 0 },
                result_position: { x: 0, y: 0, z: 0 },
                face: 0
            });

            this.logger.info(`[dropper] Dropped slot ${slot}`);
        } catch (err) {
            this.logger.error(`[dropper] Failed to drop slot ${slot}: ${err.message}`);
        }
    }

    /**
     * Schedule next cycle after delay
     */
    scheduleNextCycle() {
        if (!this.isRunning) return;

        this.currentPhase = 'idle';

        setTimeout(() => {
            this.startCycle();
        }, this.cycleDelayMs);
    }

    /**
     * Utility: Sleep for ms
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            running: this.isRunning,
            phase: this.currentPhase,
            cycleCount: this.cycleCount,
            maxCycles: this.maxCycles,
            windowId: this.windowId
        };
    }
}