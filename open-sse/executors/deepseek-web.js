import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { buildDeepSeekPowHeader, solveDeepSeekPow } from "../utils/deepseekPow.js";

const DEEPSEEK_COMPLETION_URL = PROVIDERS["deepseek-web"].baseUrl;
const DEEPSEEK_CONTINUE_URL = "https://chat.deepseek.com/api/v0/chat/continue";
const DEEPSEEK_CREATE_SESSION_URL = "https://chat.deepseek.com/api/v0/chat_session/create";
const DEEPSEEK_CREATE_POW_URL = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";
const DEEPSEEK_USER_AGENT = "DeepSeek/2.0.4 Android/35";
const MAX_CONTINUE_ROUNDS = 8;

const MODEL_CONFIG = {
  "deepseek-v4-flash": { modelType: "default", thinking: true, search: false },
  "deepseek-v4-pro": { modelType: "expert", thinking: true, search: false },
  "deepseek-v4-flash-search": { modelType: "default", thinking: true, search: true },
  "deepseek-v4-pro-search": { modelType: "expert", thinking: true, search: true },
  "deepseek-v4-vision": { modelType: "vision", thinking: true, search: false },
  "deepseek-v4-flash-nothinking": { modelType: "default", thinking: false, search: false },
  "deepseek-v4-pro-nothinking": { modelType: "expert", thinking: false, search: false },
  "deepseek-v4-flash-search-nothinking": { modelType: "default", thinking: false, search: true },
  "deepseek-v4-pro-search-nothinking": { modelType: "expert", thinking: false, search: true },
  "deepseek-v4-vision-nothinking": { modelType: "vision", thinking: false, search: false },
};

const SKIP_PATH_CONTAINS = ["quasi_status", "elapsed_secs", "pending_fragment", "conversation_mode", "fragments/-1/status", "fragments/-2/status", "fragments/-3/status"];
const SKIP_PATH_EXACT = new Set(["response/search_status"]);
const REF_MARKER_RE = /\[(?:citation|reference):\s*\d+\]/gi;

function normalizeToken(raw) {
  let token = String(raw || "").trim();
  if (/^Bearer\s+/i.test(token)) token = token.replace(/^Bearer\s+/i, "").trim();
  return token;
}

function buildHeaders(token, accept = "application/json") {
  return {
    Accept: accept,
    "Content-Type": "application/json",
    "accept-charset": "UTF-8",
    "User-Agent": DEEPSEEK_USER_AGENT,
    "x-client-platform": "android",
    "x-client-version": "2.0.4",
    "x-client-locale": "zh_CN",
    Authorization: `Bearer ${token}`,
  };
}

function extractTextFromPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return typeof part.text === "string" ? part.text : "";
  if (part.type === "input_text") return typeof part.text === "string" ? part.text : "";
  if (part.type === "image_url") return "[image omitted]";
  return "";
}

function extractMessageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map(extractTextFromPart).filter(Boolean).join("\n");
  return "";
}

function buildPrompt(messages) {
  const blocks = [];
  for (const message of messages || []) {
    const role = String(message?.role || "user").toLowerCase();
    const content = extractMessageText(message).trim();
    if (!content) continue;
    if (role === "system") blocks.push(`[System]\n${content}`);
    else if (role === "assistant") blocks.push(`[Assistant]\n${content}`);
    else if (role === "tool") blocks.push(`[Tool]\n${content}`);
    else blocks.push(`[User]\n${content}`);
  }
  blocks.push("[Assistant]");
  return blocks.join("\n\n");
}

function shouldSkipPath(path) {
  if (!path) return false;
  if (SKIP_PATH_EXACT.has(path)) return true;
  return SKIP_PATH_CONTAINS.some((pattern) => path.includes(pattern));
}

function asContentString(value) {
  if (typeof value !== "string") return "";
  return value.replace(REF_MARKER_RE, "");
}

async function* readSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return "done";
    try { return JSON.parse(payload); } catch { return null; }
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          const parsed = flush();
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) dataLines.push(buffer.trim().slice(5).trimStart());
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally {
    reader.releaseLock();
  }
}

function updateContinueState(state, chunk) {
  const topId = Number.parseInt(String(chunk?.response_message_id ?? "0"), 10);
  if (Number.isFinite(topId) && topId > 0) state.responseMessageId = topId;

  const path = String(chunk?.p || "").trim().replace(/^\/+|\/+$/g, "");
  const value = chunk?.v;
  if (["response/status", "status", "response/quasi_status", "quasi_status"].includes(path)) {
    const status = String(value || "").trim().toUpperCase();
    if (status) state.lastStatus = status;
  }
  if (["response/auto_continue", "auto_continue"].includes(path) && value === true) {
    state.lastStatus = "AUTO_CONTINUE";
  }
  const response = value?.response || chunk?.message?.response;
  if (response && typeof response === "object") {
    const id = Number.parseInt(String(response.message_id ?? "0"), 10);
    if (Number.isFinite(id) && id > 0) state.responseMessageId = id;
    const status = String(response.status || "").trim().toUpperCase();
    if (status) state.lastStatus = status;
    if (response.auto_continue === true) state.lastStatus = "AUTO_CONTINUE";
  }
}

function parseChunkParts(chunk, thinkingEnabled, currentType) {
  if (!chunk || typeof chunk !== "object") return { parts: [], error: "", finished: false, nextType: currentType };
  if (chunk.error) return { parts: [], error: typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error), finished: true, nextType: currentType };

  const path = String(chunk.p || "").trim().replace(/^\/+|\/+$/g, "");
  if (shouldSkipPath(path)) return { parts: [], error: "", finished: false, nextType: currentType };
  if (["response/status", "status"].includes(path)) {
    const status = String(chunk.v || "").trim().toUpperCase();
    return { parts: [], error: "", finished: status === "FINISHED", nextType: currentType };
  }

  let nextType = currentType;
  const parts = [];
  if (path === "response/fragments" && String(chunk.o || "").toUpperCase() === "APPEND" && Array.isArray(chunk.v)) {
    for (const fragment of chunk.v) {
      const kind = String(fragment?.type || "").toUpperCase();
      const text = asContentString(fragment?.content);
      if (!text) continue;
      if (kind === "THINK" || kind === "THINKING") {
        nextType = "thinking";
        if (thinkingEnabled) parts.push({ type: "thinking", text });
      } else {
        nextType = "text";
        parts.push({ type: "text", text });
      }
    }
    return { parts, error: "", finished: false, nextType };
  }

  if (path === "response/content") {
    const text = asContentString(chunk.v);
    return { parts: text ? [{ type: "text", text }] : [], error: "", finished: false, nextType: "text" };
  }
  if (path === "response/thinking_content") {
    const text = asContentString(chunk.v);
    if (!text) return { parts: [], error: "", finished: false, nextType };
    return { parts: thinkingEnabled ? [{ type: "thinking", text }] : [], error: "", finished: false, nextType: thinkingEnabled ? "thinking" : nextType };
  }

  if (typeof chunk.v === "string" && !path) {
    const text = asContentString(chunk.v);
    return { parts: text ? [{ type: nextType === "thinking" && thinkingEnabled ? "thinking" : "text", text }] : [], error: "", finished: false, nextType };
  }

  return { parts: [], error: "", finished: false, nextType };
}

function buildStreamingResponse(streamSource, model, createdAt, signal) {
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }] });
        for await (const item of streamSource) {
          if (signal?.aborted) break;
          if (item.error) {
            send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: { content: `[DeepSeek error: ${item.error}]` }, finish_reason: "stop", logprobs: null }] });
            break;
          }
          if (item.type === "thinking") {
            send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: { reasoning_content: item.text }, finish_reason: null, logprobs: null }] });
          } else if (item.text) {
            send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: { content: item.text }, finish_reason: null, logprobs: null }] });
          }
        }
        send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        send({ id: completionId, object: "chat.completion.chunk", created: createdAt, model, choices: [{ index: 0, delta: { content: `[DeepSeek stream error: ${error.message || String(error)}]` }, finish_reason: "stop", logprobs: null }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}

async function collectNonStreaming(streamSource, model, createdAt) {
  const content = [];
  const reasoning = [];
  for await (const item of streamSource) {
    if (item.error) {
      return new Response(JSON.stringify({ error: { message: item.error, type: "upstream_error", code: "DEEPSEEK_WEB_ERROR" } }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    if (item.type === "thinking") reasoning.push(item.text);
    else if (item.text) content.push(item.text);
  }
  const fullContent = content.join("");
  const fullReasoning = reasoning.join("");
  const promptTokens = Math.max(1, Math.ceil(fullContent.length / 4));
  const completionTokens = Math.max(1, Math.ceil((fullContent.length + fullReasoning.length) / 4));
  return new Response(JSON.stringify({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: createdAt,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: fullContent, ...(fullReasoning ? { reasoning_content: fullReasoning } : {}) }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"]);
  }

  async postJson(url, token, body, signal, proxyOptions, extraHeaders = {}) {
    return proxyAwareFetch(url, {
      method: "POST",
      headers: { ...buildHeaders(token, "application/json"), ...extraHeaders },
      body: JSON.stringify(body),
      signal,
    }, proxyOptions);
  }

  async createSession(token, signal, proxyOptions) {
    const response = await this.postJson(DEEPSEEK_CREATE_SESSION_URL, token, { agent: "chat" }, signal, proxyOptions);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`DeepSeek create session failed: HTTP ${response.status}`);
    const sessionId = data?.data?.biz_data?.id_str || data?.data?.biz_data?.id || data?.data?.biz_data?.session_id;
    if (!sessionId) throw new Error("DeepSeek create session missing session id");
    return String(sessionId);
  }

  async createPowHeader(token, signal, proxyOptions) {
    const response = await this.postJson(DEEPSEEK_CREATE_POW_URL, token, { target_path: "/api/v0/chat/completion" }, signal, proxyOptions);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`DeepSeek PoW challenge failed: HTTP ${response.status}`);
    const challenge = data?.data?.biz_data?.challenge;
    if (!challenge) throw new Error("DeepSeek PoW challenge missing payload");
    const answer = await solveDeepSeekPow(challenge, signal);
    return buildDeepSeekPowHeader(challenge, answer);
  }

  async openStream(url, token, payload, powHeader, signal, proxyOptions) {
    return proxyAwareFetch(url, {
      method: "POST",
      headers: { ...buildHeaders(token, "text/event-stream"), "x-ds-pow-response": powHeader },
      body: JSON.stringify(payload),
      signal,
    }, proxyOptions);
  }

  async *streamDeepSeek(response, token, sessionId, powHeader, thinkingEnabled, signal, proxyOptions) {
    let currentResponse = response;
    let rounds = 0;
    let currentType = thinkingEnabled ? "thinking" : "text";
    let continueState = { sessionId, responseMessageId: 0, lastStatus: "", finished: false };

    while (currentResponse?.body) {
      for await (const chunk of readSseEvents(currentResponse.body, signal)) {
        updateContinueState(continueState, chunk);
        const parsed = parseChunkParts(chunk, thinkingEnabled, currentType);
        currentType = parsed.nextType;
        if (parsed.error) {
          yield { error: parsed.error };
          return;
        }
        for (const part of parsed.parts) yield part;
        if (parsed.finished) {
          continueState.finished = true;
        }
      }

      const shouldContinue = !continueState.finished && continueState.responseMessageId > 0 && ["INCOMPLETE", "AUTO_CONTINUE"].includes(String(continueState.lastStatus || "").toUpperCase()) && rounds < MAX_CONTINUE_ROUNDS;
      if (!shouldContinue) break;

      rounds += 1;
      currentResponse = await this.openStream(DEEPSEEK_CONTINUE_URL, token, {
        chat_session_id: continueState.sessionId,
        message_id: continueState.responseMessageId,
        fallback_to_resume: true,
      }, powHeader, signal, proxyOptions);
      if (!currentResponse.ok) {
        yield { error: `DeepSeek continue failed: HTTP ${currentResponse.status}` };
        return;
      }
      continueState = { ...continueState, lastStatus: "", finished: false };
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = normalizeToken(credentials?.apiKey || credentials?.accessToken);
    if (!token) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing DeepSeek web token", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } }), url: DEEPSEEK_COMPLETION_URL, headers: {}, transformedBody: body };
    }

    const modelConfig = MODEL_CONFIG[model] || MODEL_CONFIG["deepseek-v4-flash"];
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing or empty messages array", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } }), url: DEEPSEEK_COMPLETION_URL, headers: {}, transformedBody: body };
    }

    const prompt = buildPrompt(messages);
    const createdAt = Math.floor(Date.now() / 1000);

    try {
      const sessionId = await this.createSession(token, signal, proxyOptions);
      const powHeader = await this.createPowHeader(token, signal, proxyOptions);
      const payload = {
        chat_session_id: sessionId,
        model_type: modelConfig.modelType,
        parent_message_id: null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: modelConfig.thinking,
        search_enabled: modelConfig.search,
      };

      log?.info?.("DEEPSEEK-WEB", `Query to ${model} (type=${modelConfig.modelType}, thinking=${modelConfig.thinking}, search=${modelConfig.search})`);
      const upstreamResponse = await this.openStream(DEEPSEEK_COMPLETION_URL, token, payload, powHeader, signal, proxyOptions);
      if (!upstreamResponse.ok) {
        let message = `DeepSeek Web returned HTTP ${upstreamResponse.status}`;
        if (upstreamResponse.status === 401 || upstreamResponse.status === 403) message = "DeepSeek Web auth failed — paste the web/app bearer token, not platform API key.";
        else if (upstreamResponse.status === 429) message = "DeepSeek Web rate limited or challenged the session.";
        return { response: new Response(JSON.stringify({ error: { message, type: "upstream_error" } }), { status: upstreamResponse.status, headers: { "Content-Type": "application/json" } }), url: DEEPSEEK_COMPLETION_URL, headers: buildHeaders(token), transformedBody: payload };
      }

      const streamSource = this.streamDeepSeek(upstreamResponse, token, sessionId, powHeader, modelConfig.thinking, signal, proxyOptions);
      const finalResponse = stream ? buildStreamingResponse(streamSource, model, createdAt, signal) : await collectNonStreaming(streamSource, model, createdAt);
      return { response: finalResponse, url: DEEPSEEK_COMPLETION_URL, headers: buildHeaders(token), transformedBody: payload };
    } catch (error) {
      log?.error?.("DEEPSEEK-WEB", error?.message || String(error));
      return { response: new Response(JSON.stringify({ error: { message: `DeepSeek Web failed: ${error.message || String(error)}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: DEEPSEEK_COMPLETION_URL, headers: buildHeaders(token), transformedBody: body };
    }
  }
}

export default DeepSeekWebExecutor;
