import type { LoaderFunctionArgs } from "react-router";
import { getSettings } from "~/lib/config/storage";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiVendorsOpenAIModels" });

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const settings = await getSettings();
    const vendorConfig = settings.vendors?.openai;
    const apiKey = vendorConfig?.apiKey?.trim();
    const baseUrl = (vendorConfig?.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");

    if (!apiKey) {
      return Response.json({ error: "OpenAI API key not configured" }, { status: 400 });
    }

    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        typeof payload === "object" && payload && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message || "Failed to fetch models"
          : "Failed to fetch models";

      log.warn({ status: response.status, error: errorMessage }, "openai models request failed");
      return Response.json({ error: errorMessage }, { status: response.status });
    }

    const models = Array.isArray((payload as { data?: unknown[] } | null)?.data)
      ? (payload as { data: Array<{ id: string; owned_by?: string }> }).data.map((model) => ({
          id: model.id,
          owned_by: model.owned_by,
        }))
      : [];

    return Response.json({ models });
  } catch (error) {
    log.error({ err: error }, "openai models request threw");
    return Response.json({ error: "Failed to fetch OpenAI models" }, { status: 500 });
  }
}
