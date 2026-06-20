import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from 'react';

interface MediaRefreshContextValue {
  refreshToken: number;
  triggerRefresh: () => void;
}

const defaultValue: MediaRefreshContextValue = {
  refreshToken: 0,
  triggerRefresh: () => {},
};

export const MediaRefreshContext =
  createContext<MediaRefreshContextValue>(defaultValue);

interface MediaRefreshProviderProps {
  children: ReactNode;
}

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

export function useMediaRefresh(): MediaRefreshContextValue {
  return useContext(MediaRefreshContext);
}
