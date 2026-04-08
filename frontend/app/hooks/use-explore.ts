import { api } from "~/lib/api";
import type { ExplorePostsResponse, ExplorePostWithComments } from "~/types/explore";

export async function fetchExplorePosts(params?: {
  before?: string;
  after?: string;
  limit?: number;
}): Promise<ExplorePostsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.before) searchParams.set("before", params.before);
  if (params?.after) searchParams.set("after", params.after);
  if (params?.limit) searchParams.set("limit", String(params.limit));

  const qs = searchParams.toString();
  const response = await api.get(`/api/explore/posts${qs ? "?" + qs : ""}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchExplorePost(id: string): Promise<ExplorePostWithComments> {
  const response = await api.get(`/api/explore/posts/${id}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function deleteExplorePost(id: string): Promise<void> {
  const response = await api.delete(`/api/explore/posts/${id}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
