import { getApiKey } from "./apiKeyStore";

const API_BASE_URL = "https://new.12ai.org";
const MODEL_NAME = "gemini-3.1-flash-lite-image";
const REQUEST_TIMEOUT_MS = 180_000;

export interface ApiError extends Error {
  status?: number;
}

/**
 * Clean up error messages so they never reveal the full API Key.
 */
export function sanitizeError(err: any): string {
  const message = err.message || String(err);
  const apiKey = getApiKey();
  if (apiKey && apiKey.length > 5) {
    // Replace API Key with hidden placeholder in errors
    const escaped = apiKey.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(escaped, "g");
    return message.replace(regex, "sk-...HIDDEN...");
  }
  return message;
}

/**
 * Downloads a remote image URL and returns its binary Buffer and mime-type.
 */
async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "image/*" },
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("结果图片下载超时（180 秒）。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to download processed image from URL: ${url}. Status: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "image/png";

  return { buffer, mimeType: contentType };
}

/**
 * Highly robust parser that extracts image data from any API response format.
 * Supports:
 * 1. Image URLs (http/https)
 * 2. Base64 string or Data URL
 * 3. Markdown image links: ![image](url)
 * 4. Image object in chat completions (choices[0].message.image, choices[0].message.image_url)
 * 5. OpenAI Image Generation format (data[0].url, data[0].b64_json)
 */
export function parseImageFromResponse(body: any): { url?: string; base64?: string; dataUrl?: string } {
  if (!body) {
    throw new Error("Empty API response body");
  }

  // 1. Check OpenAI standard image generation response format: data[0].url or data[0].b64_json
  if (body.data && Array.isArray(body.data) && body.data.length > 0) {
    const first = body.data[0];
    if (first.b64_json) {
      return { base64: first.b64_json };
    }
    if (first.url) {
      return { url: first.url };
    }
  }

  // 2. Check chat completions choices message response format
  let textContent = "";
  if (body.choices && Array.isArray(body.choices) && body.choices.length > 0) {
    const choice = body.choices[0];
    const message = choice.message;

    if (message) {
      // Direct image object in response message: e.g. message.image, message.image_url.url
      if (message.image) {
        if (typeof message.image === "string") {
          if (message.image.startsWith("data:")) return { dataUrl: message.image };
          if (message.image.startsWith("http")) return { url: message.image };
          return { base64: message.image };
        }
        if (message.image.url) {
          return { url: message.image.url };
        }
      }

      if (message.image_url) {
        if (typeof message.image_url === "string") {
          if (message.image_url.startsWith("http")) return { url: message.image_url };
          if (message.image_url.startsWith("data:")) return { dataUrl: message.image_url };
        } else if (message.image_url.url) {
          return { url: message.image_url.url };
        }
      }

      // Read text content to search for Markdown or links
      if (typeof message.content === "string") {
        textContent = message.content;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            textContent += part.text;
          } else if (part.type === "image_url" && part.image_url) {
            return { url: part.image_url.url || part.image_url };
          }
        }
      }
    }
  }

  // If no choices, but direct text content on body
  if (!textContent && typeof body.content === "string") {
    textContent = body.content;
  }

  if (textContent) {
    const trimmedText = textContent.trim();

    // Try parsing the text content as JSON (sometimes models output JSON)
    try {
      if ((trimmedText.startsWith("{") && trimmedText.endsWith("}")) || (trimmedText.startsWith("[") && trimmedText.endsWith("]"))) {
        const parsed = JSON.parse(trimmedText);
        if (parsed.image) return { base64: parsed.image };
        if (parsed.url) return { url: parsed.url };
        if (parsed.b64_json) return { base64: parsed.b64_json };
        if (parsed.data) {
          if (Array.isArray(parsed.data) && parsed.data[0]) {
            if (parsed.data[0].url) return { url: parsed.data[0].url };
            if (parsed.data[0].b64_json) return { base64: parsed.data[0].b64_json };
          }
        }
      }
    } catch {
      // Not a valid JSON string, continue search
    }

    // A. Check for Markdown image link: ![image](url)
    const markdownRegex = /!\[.*?\]\((.*?)\)/i;
    const match = markdownRegex.exec(trimmedText);
    if (match && match[1]) {
      const extracted = match[1].trim();
      if (extracted.startsWith("data:")) {
        return { dataUrl: extracted };
      }
      if (extracted.startsWith("http")) {
        return { url: extracted };
      }
      return { base64: extracted };
    }

    // B. Check for Data URL: data:image/jpeg;base64,...
    const dataUrlRegex = /(data:image\/[a-zA-Z+.-]+;base64,[a-zA-Z0-9+/=]+)/;
    const dataUrlMatch = dataUrlRegex.exec(trimmedText);
    if (dataUrlMatch && dataUrlMatch[1]) {
      return { dataUrl: dataUrlMatch[1] };
    }

    // C. Check for HTTP/HTTPS URL
    const urlRegex = /(https?:\/\/[^\s"'`()<>]+)/;
    const urlMatch = urlRegex.exec(trimmedText);
    if (urlMatch && urlMatch[1]) {
      return { url: urlMatch[1] };
    }

    // D. Check for clean Base64 string (if text looks like plain Base64, e.g. longer than 1000 characters with no spaces)
    const base64Clean = trimmedText.replace(/\s/g, "");
    if (base64Clean.length > 500 && /^[a-zA-Z0-9+/=]+$/.test(base64Clean)) {
      return { base64: base64Clean };
    }
  }

  // 3. Fallback direct properties on body (some proxies put them at root level)
  if (body.url) return { url: body.url };
  if (body.image) return { base64: body.image };
  if (body.b64_json) return { base64: body.b64_json };
  if (body.outputs && Array.isArray(body.outputs) && body.outputs[0]) {
    return { url: body.outputs[0] };
  }

  throw new Error("Could not find any valid image URL, base64 or markdown link in model response");
}

/**
 * Sends image-to-image processing request to Gemini model via 12ai.org
 */
export async function callImageModel(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  promptText: string
): Promise<{ buffer: Buffer; extension: string }> {
  const url = `${API_BASE_URL}/v1/chat/completions`;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  const body = {
    model: MODEL_NAME,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: promptText,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
  };

  console.log(`Sending image model request to ${url} with model ${MODEL_NAME}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("模型请求超时（180 秒）。");
    }
    throw new Error(`网络连接失败：${err.message || err}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let hint = "";
    if (response.status === 401) {
      hint = " (API Key is invalid or unauthorized)";
    } else if (response.status === 429) {
      hint = " (Rate limit exceeded / Too many requests)";
    } else if (response.status === 403) {
      hint = " (No model permissions or account issue)";
    }
    throw new Error(`Model API request failed with status ${response.status}${hint}. Details: ${errorText.substring(0, 500)}`);
  }

  const json = await response.json();
  const parsed = parseImageFromResponse(json);

  // Download/resolve the image to a Buffer
  if (parsed.base64) {
    const buffer = Buffer.from(parsed.base64, "base64");
    return { buffer, extension: mimeType.split("/")[1] || "png" };
  } else if (parsed.dataUrl) {
    const split = parsed.dataUrl.split(",");
    const dataPart = split[1] || "";
    const headerPart = split[0] || "";
    const extractedMime = headerPart.match(/:(.*?);/)?.[1] || "image/png";
    const buffer = Buffer.from(dataPart, "base64");
    return { buffer, extension: extractedMime.split("/")[1] || "png" };
  } else if (parsed.url) {
    console.log(`Model returned image URL: ${parsed.url}, starting download...`);
    const { buffer, mimeType: downloadedMime } = await downloadImage(parsed.url);
    return { buffer, extension: downloadedMime.split("/")[1] || "png" };
  }

  throw new Error("No image output returned from API parser.");
}
