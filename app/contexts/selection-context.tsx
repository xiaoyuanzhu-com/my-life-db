import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';

interface SelectionContextValue {
  /** Set of selected file paths */
  selectedPaths: Set<string>;
  /** Whether selection mode is active */
  isSelectionMode: boolean;
  /** Toggle selection of a specific path */
  toggleSelection: (path: string) => void;
  /** Clear all selections and exit selection mode */
  clearSelection: () => void;
  /** Enter selection mode and select the first item */
  enterSelectionMode: (path: string) => void;
  /** Check if a specific path is selected */
  isSelected: (path: string) => boolean;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Exit selection mode if no items remain selected
        if (next.size === 0) {
          setIsSelectionMode(false);
        }
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setIsSelectionMode(false);
  }, []);

  const enterSelectionMode = useCallback((path: string) => {
    setIsSelectionMode(true);
    setSelectedPaths(new Set([path]));
  }, []);

  const isSelected = useCallback((path: string) => {
    return selectedPaths.has(path);
  }, [selectedPaths]);

  const value = useMemo<SelectionContextValue>(() => ({
    selectedPaths,
    isSelectionMode,
    toggleSelection,
    clearSelection,
    enterSelectionMode,
    isSelected,
  }), [selectedPaths, isSelectionMode, toggleSelection, clearSelection, enterSelectionMode, isSelected]);

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
  return context;
}

/**
 * Safe hook that returns null if not within SelectionProvider
 * Useful for components that may be used outside selection context
 */
export function useSelectionSafe() {
  return useContext(SelectionContext);
}
