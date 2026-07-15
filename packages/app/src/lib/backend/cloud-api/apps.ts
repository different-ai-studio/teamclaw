import type { AppsBackend, AppRow, AppSessionRow, DeployAppResult } from "../types";
import { CloudApiError, type CloudApiClient } from "./http";

type Page<T> = { items: T[] };

export function createAppsModule(client: CloudApiClient): AppsBackend {
  return {
    async listApps(teamId) {
      const params = new URLSearchParams({ teamId, limit: "100" });
      const page = await client.get<Page<AppRow>>(`/v1/apps?${params}`);
      return page.items;
    },
    async createApp(input) {
      return client.post<AppRow>("/v1/apps", input);
    },
    async getApp(appId) {
      try {
        return await client.get<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async listAppSessions(appId) {
      const page = await client.get<Page<AppSessionRow>>(`/v1/apps/${encodeURIComponent(appId)}/sessions`);
      return page.items;
    },
    async updateAppProvisionStatus(appId, provisionStatus) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { provisionStatus });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async renameApp(appId, name) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { name });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async deployApp(appId) {
      return client.post<DeployAppResult>(`/v1/apps/${encodeURIComponent(appId)}/deploy`, {});
    },
    async finalizeDeploy(appId) {
      return client.post<AppRow>(`/v1/apps/${encodeURIComponent(appId)}/deploy/finalize`, {});
    },
  };
}
