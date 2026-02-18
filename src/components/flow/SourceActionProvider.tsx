import type { ReactNode } from "react";
import {
  SourceActionContext,
  type SourceActionContextValue,
} from "./SourceActionContext";

export function SourceActionProvider({
  value,
  children,
}: {
  value: SourceActionContextValue;
  children: ReactNode;
}) {
  return (
    <SourceActionContext.Provider value={value}>
      {children}
    </SourceActionContext.Provider>
  );
}
