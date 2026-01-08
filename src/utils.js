/**
 * UTILITY FUNCTIONS
 */

/**
 * Strip Minecraft formatting codes (§x) from text
 * Removes color codes like §r, §7, §b, etc.
 * @param {string} text - Text with formatting codes
 * @returns {string} - Clean text without formatting
 */
export function stripMinecraftFormatting(text) {
  if (typeof text !== "string") return text;
  // § followed by any character (color/format code)
  return text.replace(/§./g, "");
}

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format timestamp for logging
 * @returns {string}
 */
export function formatTimestamp() {
  return new Date().toISOString();
}

/**
 * Safe JSON stringify (handles BigInt)
 * @param {any} obj - Object to stringify
 * @returns {string}
 */
export function safeStringify(obj) {
  return JSON.stringify(
    obj,
    (key, value) => {
      return typeof value === "bigint" ? value.toString() : value;
    },
    2
  );
}
