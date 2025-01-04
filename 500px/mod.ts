/**
 * Interact with 500px, the photo sharing platform.
 *
 * @module
 */

import { main } from "./main.ts";

export * from "./client.ts";
export * from "./data.ts";
export * from "./types.ts";

if (import.meta.main) await main();
