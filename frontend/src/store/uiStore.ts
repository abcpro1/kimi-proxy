import { create } from "zustand";

interface UIState {
  expandedLogId: number | null;
  // Key: "logId-columnType" (e.g. "123-request", "123-response") -> tabIndex
  tabStates: Record<string, number>;

  setExpandedLogId: (id: number | null) => void;
  setTabState: (key: string, index: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  expandedLogId: null,
  tabStates: {},
  setExpandedLogId: (id) => set({ expandedLogId: id }),
  setTabState: (key, index) =>
    set((state) => ({
      tabStates: { ...state.tabStates, [key]: index },
    })),
}));
