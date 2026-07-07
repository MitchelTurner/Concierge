/**
 * Audio transcription via the OpenAI audio API (optional — enabled when
 * OPENAI_API_KEY is set). Used for Telegram voice messages (OGG/Opus) and the
 * dashboard's live call recording, which streams short WebM/MP4 segments. All
 * of these formats are accepted by the transcription endpoint directly.
 */
import type { Config } from "./config.js";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

export function isTranscriptionConfigured(config: Config): boolean {
  return config.openaiApiKey.length > 0;
}

export async function transcribeAudio(
  config: Config,
  data: ArrayBuffer,
  filename: string,
  mimeType: string
): Promise<string> {
  if (!isTranscriptionConfigured(config)) {
    throw new Error("Transcription not configured (set OPENAI_API_KEY).");
  }

  const form = new FormData();
  form.append("file", new Blob([data], { type: mimeType }), filename);
  form.append("model", config.openaiTranscribeModel);

  const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`transcription failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { text?: unknown };
  const text = String(json.text ?? "").trim();
  if (!text) throw new Error("transcription returned no text");
  return text;
}
