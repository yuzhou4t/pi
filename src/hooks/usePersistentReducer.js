import { useEffect, useReducer } from "react";

export const RUN_STORAGE_VERSION = 1;
export const RUN_STORAGE_KEY = `pi-agent:journal-reading-run:v${RUN_STORAGE_VERSION}`;

function resolveInitialState(initialState) {
  return typeof initialState === "function" ? initialState() : initialState;
}

function restoreState(storageKey, version, initialState, validate) {
  const fallback = resolveInitialState(initialState);
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    if (saved?.version !== version || !validate(saved.state)) return fallback;
    return saved.state;
  } catch {
    return fallback;
  }
}

export function usePersistentReducer(
  reducer,
  initialState,
  {
    storageKey = RUN_STORAGE_KEY,
    version = RUN_STORAGE_VERSION,
    validate = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  } = {},
) {
  const [state, dispatch] = useReducer(
    reducer,
    initialState,
    (value) => restoreState(storageKey, version, value, validate),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ version, state }));
    } catch {
      // Storage can be unavailable in private or constrained browser contexts.
    }
  }, [state, storageKey, version]);

  return [state, dispatch];
}
