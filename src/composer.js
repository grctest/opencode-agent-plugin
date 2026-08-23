export { getPersonas, getPersonaTags } from "./composer/persona-loader.js";
export { composeRoomWithSimilarity, formatRoomPreview } from "./composer/room.js";
// Re-export for backward compat: also export persona loading helpers if needed
export * from "./composer/persona-loader.js";
