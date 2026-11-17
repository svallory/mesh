// The capabilities of the test bus that delivers from several processes, shared by the tests and the worker script.
export const MULTI_CAPABILITIES = ["ordered-delivery", "replay", "subscribe", "multi-process"] as const;
