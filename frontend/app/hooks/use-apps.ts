import { useQuery } from "@tanstack/react-query";
import { api } from "~/lib/api";
import type { App, AppDetail } from "~/types/apps";

export function useApps() {
  return useQuery({
    queryKey: ["apps"],
    queryFn: async (): Promise<App[]> => {
      const res = await api.get("/api/data/apps");
      const body = await res.json();
      return body.apps ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useApp(id: string | null) {
  return useQuery({
    queryKey: ["apps", id],
    queryFn: async (): Promise<AppDetail> => {
      const res = await api.get(`/api/data/apps/${id}`);
      if (!res.ok) throw new Error(`app ${id} not found`);
      return res.json();
    },
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}
