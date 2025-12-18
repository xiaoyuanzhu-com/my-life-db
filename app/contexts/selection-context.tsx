import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

type SelectionSnapshot = {
  selectedPaths: Set<string>;
  isSelectionMode: boolean;
};

const emptySelectionSnapshot: SelectionSnapshot = {
  selectedPaths: new Set(),
  isSelectionMode: false,
};

const getEmptySnapshot = () => emptySelectionSnapshot;
const noopSubscribe = () => () => {};

interface SelectionContextValue {
  /** Subscribe to selection state changes */
  subscribe: (listener: () => void) => () => void;
  /** Return the current selection snapshot */
  getSnapshot: () => SelectionSnapshot;
  /** Toggle selection of a specific path */
  toggleSelection: (path: string) => void;
  /** Clear all selections and exit selection mode */
  clearSelection: () => void;
  /** Enter selection mode and select the first item */
  enterSelectionMode: (path: string) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef<SelectionSnapshot>({
    selectedPaths: new Set(),
    isSelectionMode: false,
  });
  const listenersRef = useRef(new Set<() => void>());

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const getSnapshot = useCallback(() => stateRef.current, []);

  const updateState = useCallback((next: SelectionSnapshot | ((prev: SelectionSnapshot) => SelectionSnapshot)) => {
    const resolved = typeof next === 'function' ? next(stateRef.current) : next;
    const prev = stateRef.current;

    // Skip notifying if nothing actually changed
    if (
      prev.isSelectionMode === resolved.isSelectionMode &&
      prev.selectedPaths.size === resolved.selectedPaths.size &&
      [...prev.selectedPaths].every((path) => resolved.selectedPaths.has(path))
    ) {
      return;
    }

    stateRef.current = resolved;
    listenersRef.current.forEach((listener) => listener());
  }, []);

  const toggleSelection = useCallback((path: string) => {
    updateState(prev => {
      const nextPaths = new Set(prev.selectedPaths);
      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }

      return {
        selectedPaths: nextPaths,
        isSelectionMode: nextPaths.size > 0,
      };
    });
  }, [updateState]);

  const clearSelection = useCallback(() => {
    updateState({ selectedPaths: new Set(), isSelectionMode: false });
  }, [updateState]);

  const enterSelectionMode = useCallback((path: string) => {
    updateState({ selectedPaths: new Set([path]), isSelectionMode: true });
  }, [updateState]);

  const value = useMemo<SelectionContextValue>(() => ({
    subscribe,
    getSnapshot,
    toggleSelection,
    clearSelection,
    enterSelectionMode,
  }), [subscribe, getSnapshot, toggleSelection, clearSelection, enterSelectionMode]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelection must be used within a SelectionProvider');
  }

  const snapshot = useSyncExternalStore(context.subscribe, context.getSnapshot, context.getSnapshot);
  const isSelected = useCallback((path: string) => snapshot.selectedPaths.has(path), [snapshot.selectedPaths]);

  return useMemo(() => ({
    selectedPaths: snapshot.selectedPaths,
    isSelectionMode: snapshot.isSelectionMode,
    toggleSelection: context.toggleSelection,
    clearSelection: context.clearSelection,
    enterSelectionMode: context.enterSelectionMode,
    isSelected,
  }), [snapshot.selectedPaths, snapshot.isSelectionMode, context.toggleSelection, context.clearSelection, context.enterSelectionMode, isSelected]);
}

/**
 * Safe hook that returns null if not within SelectionProvider
 * Useful for components that may be used outside selection context
 */
export function useSelectionSafe() {
  const context = useContext(SelectionContext);

  const snapshot = useSyncExternalStore(
    context?.subscribe ?? noopSubscribe,
    context?.getSnapshot ?? getEmptySnapshot,
    context?.getSnapshot ?? getEmptySnapshot,
  );
  const isSelected = useCallback((path: string) => snapshot.selectedPaths.has(path), [snapshot.selectedPaths]);

  if (!context) return null;

  return useMemo(() => ({
    selectedPaths: snapshot.selectedPaths,
    isSelectionMode: snapshot.isSelectionMode,
    toggleSelection: context.toggleSelection,
    clearSelection: context.clearSelection,
    enterSelectionMode: context.enterSelectionMode,
    isSelected,
  }), [snapshot.selectedPaths, snapshot.isSelectionMode, context.toggleSelection, context.clearSelection, context.enterSelectionMode, isSelected]);
}

/**
 * Lightweight hook for components that only need to know whether selection mode
 * is active without re-rendering on selection set changes.
 */
export function useSelectionMode() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelectionMode must be used within a SelectionProvider');
  }

  const getIsSelectionMode = useCallback(
    () => context.getSnapshot().isSelectionMode,
    [context],
  );

  const isSelectionMode = useSyncExternalStore(
    context.subscribe,
    getIsSelectionMode,
    getIsSelectionMode,
  );

  return useMemo(() => ({
    isSelectionMode,
    clearSelection: context.clearSelection,
  }), [isSelectionMode, context.clearSelection]);
}

/**
 * Subscribe to selection state for a specific path so only items whose state
 * actually changes re-render.
 */
export function useSelectionForPath(path: string) {
  const context = useContext(SelectionContext);

  const getSelectionState = useCallback(() => {
    const snapshot = context?.getSnapshot ? context.getSnapshot() : emptySelectionSnapshot;
    if (!snapshot.isSelectionMode) return 0;
    return snapshot.selectedPaths.has(path) ? 2 : 1;
  }, [context, path]);

  const selectionState = useSyncExternalStore(
    context?.subscribe ?? noopSubscribe,
    getSelectionState,
    getSelectionState,
  );

  if (!context) return null;

  return {
    isSelectionMode: selectionState > 0,
    isSelected: selectionState === 2,
    toggleSelection: context.toggleSelection,
  };
}
