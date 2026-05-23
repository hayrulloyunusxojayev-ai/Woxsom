import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { SendChatMessageBody, SendChatMessageResponse } from "@workspace/api-zod";

const router = Router();

const DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct";

const SYSTEM_PROMPT = `You are Malika, a professional AI sales assistant for an online shop. 
You help customers find products, answer questions about the catalog, and assist with placing orders.
Be friendly, concise, and helpful. Respond in the same language the customer uses (Uzbek or Russian).
When responding in English (e.g. during testing), keep answers brief and professional.`;

router.post("/chat/message", async (req, res) => {
  const parsed = SendChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { messages, model = DEFAULT_MODEL } = parsed.data;

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
      ],
      max_tokens: 512,
      temperature: 0.7,
    });

    const content = completion.choices[0]?.message?.content ?? "";

    const payload = {
      content,
      model: completion.model ?? model,
    };

    const response = SendChatMessageResponse.parse(payload);
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Chat completion failed");
    res.status(500).json({ error: "AI service unavailable" });
  }
});

router.get("/chat/stream", async (req, res) => {
  const message = String(req.query["message"] ?? "");
  const model = String(req.query["model"] ?? DEFAULT_MODEL);

  if (!message.trim()) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      max_tokens: 512,
      temperature: 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    req.log.error({ err }, "Chat stream failed");
    res.write(`data: ${JSON.stringify({ error: "AI service unavailable" })}\n\n`);
    res.end();
  }
});

export default router;
