import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { NavigationModal } from '~/components/FileCard/navigation-modal';

interface ModalNavigationSnapshot {
  /** Currently displayed file in modal (null if modal closed) */
  currentFile: FileWithDigests | null;
  /** Whether modal is open */
  isOpen: boolean;
  /** Whether there's a previous file to navigate to */
  hasPrev: boolean;
  /** Whether there's a next file to navigate to */
  hasNext: boolean;
}

const emptySnapshot: ModalNavigationSnapshot = {
  currentFile: null,
  isOpen: false,
  hasPrev: false,
  hasNext: false,
};

const getEmptySnapshot = () => emptySnapshot;
const noopSubscribe = () => () => {};

interface ModalNavigationContextValue {
  /** Subscribe to navigation state changes */
  subscribe: (listener: () => void) => () => void;
  /** Return the current navigation snapshot */
  getSnapshot: () => ModalNavigationSnapshot;
  /** Open modal with a specific file */
  openModal: (file: FileWithDigests) => void;
  /** Close the modal */
  closeModal: () => void;
  /** Navigate to previous file */
  goToPrev: () => void;
  /** Navigate to next file */
  goToNext: () => void;
}

const ModalNavigationContext = createContext<ModalNavigationContextValue | null>(null);

interface ModalNavigationProviderProps {
  children: ReactNode;
  /** List of files available for navigation (in display order) */
  files: FileWithDigests[];
}

/**
 * Provider for modal navigation functionality.
 * Manages which file is displayed in the modal and enables prev/next navigation.
 */
export function ModalNavigationProvider({ children, files }: ModalNavigationProviderProps) {
  const filesRef = useRef(files);
  filesRef.current = files;

  const stateRef = useRef<ModalNavigationSnapshot>(emptySnapshot);
  const listenersRef = useRef(new Set<() => void>());

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const getSnapshot = useCallback(() => stateRef.current, []);

  const notifyListeners = useCallback(() => {
    listenersRef.current.forEach((listener) => listener());
  }, []);

  const updateState = useCallback((currentFile: FileWithDigests | null) => {
    if (!currentFile) {
      stateRef.current = emptySnapshot;
      notifyListeners();
      return;
    }

    const currentIndex = filesRef.current.findIndex((f) => f.path === currentFile.path);
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex >= 0 && currentIndex < filesRef.current.length - 1;

    stateRef.current = {
      currentFile,
      isOpen: true,
      hasPrev,
      hasNext,
    };
    notifyListeners();
  }, [notifyListeners]);

  const openModal = useCallback((file: FileWithDigests) => {
    updateState(file);
  }, [updateState]);

  const closeModal = useCallback(() => {
    updateState(null);
  }, [updateState]);

  const goToPrev = useCallback(() => {
    const current = stateRef.current.currentFile;
    if (!current) return;

    const currentIndex = filesRef.current.findIndex((f) => f.path === current.path);
    if (currentIndex > 0) {
      updateState(filesRef.current[currentIndex - 1]);
    }
  }, [updateState]);

  const goToNext = useCallback(() => {
    const current = stateRef.current.currentFile;
    if (!current) return;

    const currentIndex = filesRef.current.findIndex((f) => f.path === current.path);
    if (currentIndex >= 0 && currentIndex < filesRef.current.length - 1) {
      updateState(filesRef.current[currentIndex + 1]);
    }
  }, [updateState]);

  const value = useMemo<ModalNavigationContextValue>(() => ({
    subscribe,
    getSnapshot,
    openModal,
    closeModal,
    goToPrev,
    goToNext,
  }), [subscribe, getSnapshot, openModal, closeModal, goToPrev, goToNext]);

  return (
    <ModalNavigationContext.Provider value={value}>
      {children}
      <NavigationModal />
    </ModalNavigationContext.Provider>
  );
}

/**
 * Hook to access modal navigation functionality.
 * Throws if used outside ModalNavigationProvider.
 */
export function useModalNavigation() {
  const context = useContext(ModalNavigationContext);
  if (!context) {
    throw new Error('useModalNavigation must be used within a ModalNavigationProvider');
  }

  const snapshot = useSyncExternalStore(context.subscribe, context.getSnapshot, context.getSnapshot);

  return useMemo(() => ({
    currentFile: snapshot.currentFile,
    isOpen: snapshot.isOpen,
    hasPrev: snapshot.hasPrev,
    hasNext: snapshot.hasNext,
    openModal: context.openModal,
    closeModal: context.closeModal,
    goToPrev: context.goToPrev,
    goToNext: context.goToNext,
  }), [
    snapshot.currentFile,
    snapshot.isOpen,
    snapshot.hasPrev,
    snapshot.hasNext,
    context.openModal,
    context.closeModal,
    context.goToPrev,
    context.goToNext,
  ]);
}

/**
 * Safe hook that returns null if not within ModalNavigationProvider.
 * Useful for components that may be used outside navigation context.
 */
export function useModalNavigationSafe() {
  const context = useContext(ModalNavigationContext);

  const snapshot = useSyncExternalStore(
    context?.subscribe ?? noopSubscribe,
    context?.getSnapshot ?? getEmptySnapshot,
    context?.getSnapshot ?? getEmptySnapshot,
  );

  if (!context) return null;

  return {
    currentFile: snapshot.currentFile,
    isOpen: snapshot.isOpen,
    hasPrev: snapshot.hasPrev,
    hasNext: snapshot.hasNext,
    openModal: context.openModal,
    closeModal: context.closeModal,
    goToPrev: context.goToPrev,
    goToNext: context.goToNext,
  };
}
