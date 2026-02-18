import { createContext, useContext } from "react";

export interface SourceActionContextValue {
  openReference: (url: string, label?: string) => void;
}

export const SourceActionContext =
  createContext<SourceActionContextValue | null>(null);

export function useSourceActionContext() {
  return useContext(SourceActionContext);
}
