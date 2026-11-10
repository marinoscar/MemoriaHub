import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from 'react';

/**
 * Media Refresh Context Value.
 *
 * @stability experimental
 */
export interface MediaRefreshContextValue {
  refreshToken: number;
  /** The `triggerRefresh` function. */
  triggerRefresh: () => void;
}

const defaultValue: MediaRefreshContextValue = {
  refreshToken: 0,
  triggerRefresh: () => {},
};

/**
 * Media Refresh Context.
 *
 * @stability experimental
 */
export const MediaRefreshContext =
  createContext<MediaRefreshContextValue>(defaultValue);

/**
 * Media Refresh Provider Props.
 *
 * @stability experimental
 */
export interface MediaRefreshProviderProps {
  children: ReactNode;
}

/**
 * Media Refresh Provider.
 *
 * @stability experimental
 */
export function MediaRefreshProvider({ children }: MediaRefreshProviderProps) {
  const [refreshToken, setRefreshToken] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshToken((prev) => prev + 1);
  }, []);

  return (
    <MediaRefreshContext.Provider value={{ refreshToken, triggerRefresh }}>
      {children}
    </MediaRefreshContext.Provider>
  );
}

/**
 * Hook: Media Refresh.
 *
 * @stability experimental
 */
export function useMediaRefresh(): MediaRefreshContextValue {
  return useContext(MediaRefreshContext);
}
