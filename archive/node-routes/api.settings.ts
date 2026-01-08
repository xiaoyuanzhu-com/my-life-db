import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { loadSettings, saveSettings, resetSettings } from "~/.server/config/storage";
import { sanitizeSettings } from "~/lib/config/settings";
import type { UserSettings } from "~/lib/config/settings";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiSettings" });

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const settings = await loadSettings();
    const sanitized = sanitizeSettings(settings);
    return Response.json(sanitized);
  } catch (error) {
    log.error({ err: error }, "load settings failed");
    return Response.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "PUT") {
    try {
      const updates = (await request.json()) as Partial<UserSettings>;
      const currentSettings = await loadSettings();

      const updatedSettings: UserSettings = {
        ...currentSettings,
        ...updates,
        preferences: {
          ...currentSettings.preferences,
          ...updates.preferences,
        },
        vendors: {
          ...currentSettings.vendors,
          ...updates.vendors,
        },
        digesters: {
          ...currentSettings.digesters,
          ...updates.digesters,
        },
        extraction: {
          ...currentSettings.extraction,
          ...updates.extraction,
        },
        enrichment: updates.enrichment
          ? ({
              ...currentSettings.enrichment,
              ...updates.enrichment,
              text: {
                ...currentSettings.enrichment?.text,
                ...updates.enrichment?.text,
              },
              url: {
                ...currentSettings.enrichment?.url,
                ...updates.enrichment?.url,
              },
              image: {
                ...currentSettings.enrichment?.image,
                ...updates.enrichment?.image,
              },
              audio: {
                ...currentSettings.enrichment?.audio,
                ...updates.enrichment?.audio,
              },
              video: {
                ...currentSettings.enrichment?.video,
                ...updates.enrichment?.video,
              },
              pdf: {
                ...currentSettings.enrichment?.pdf,
                ...updates.enrichment?.pdf,
              },
            } as UserSettings["enrichment"])
          : currentSettings.enrichment,
        storage: {
          ...currentSettings.storage,
          ...updates.storage,
        },
      };

      await saveSettings(updatedSettings);
      const sanitized = sanitizeSettings(updatedSettings);
      return Response.json(sanitized);
    } catch (error) {
      log.error({ err: error }, "update settings failed");
      return Response.json(
        {
          error: "Failed to update settings",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }

  if (request.method === "POST") {
    try {
      const { action } = await request.json();
      if (action === "reset") {
        const settings = await resetSettings();
        const sanitized = sanitizeSettings(settings);
        return Response.json(sanitized);
      }
      return Response.json({ error: "Invalid action" }, { status: 400 });
    } catch (error) {
      log.error({ err: error }, "reset settings failed");
      return Response.json({ error: "Failed to reset settings" }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
