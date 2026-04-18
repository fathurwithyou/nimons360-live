import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";

type LiveStream = {
  id: string;
  streamKey: string;
  familyId: string;
  broadcasterId: string;
  broadcasterName: string;
  title: string;
  startedAt: number;
};

const PORT = Number(process.env.PORT ?? 4000);
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "localhost";
const RTMP_PORT = Number(process.env.RTMP_PORT ?? 1935);
const HLS_PORT = Number(process.env.HLS_PORT ?? 8888);
const API_KEY = process.env.API_KEY ?? "";

const fastify = Fastify({ logger: true });

const streams = new Map<string, LiveStream>();
const subscribers = new Set<WebSocket>();

const requireApiKey = (req: { headers: Record<string, string | string[] | undefined> }) => {
  if (!API_KEY) return true;
  const sent = req.headers["x-api-key"];
  return typeof sent === "string" && sent === API_KEY;
};

const streamsForFamily = (familyId: string): LiveStream[] =>
  Array.from(streams.values()).filter((s) => s.familyId === familyId);

const broadcast = (event: unknown) => {
  const payload = JSON.stringify(event);
  for (const ws of subscribers) {
    try {
      ws.send(payload);
    } catch {
      subscribers.delete(ws);
    }
  }
};

const toPublicDto = (s: LiveStream) => ({
  id: s.id,
  familyId: s.familyId,
  broadcasterId: s.broadcasterId,
  broadcasterName: s.broadcasterName,
  title: s.title,
  startedAt: s.startedAt,
  rtmpUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live`,
  streamKey: s.streamKey,
  hlsUrl: `http://${PUBLIC_HOST}:${HLS_PORT}/live/${s.streamKey}/index.m3u8`,
});

async function start() {
  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyWebsocket);

  fastify.get("/health", async () => ({
    status: "ok",
    activeStreams: streams.size,
    uptimeSec: Math.floor(process.uptime()),
  }));

  fastify.post<{
    Body: {
      familyId: string;
      broadcasterId: string;
      broadcasterName: string;
      title?: string;
    };
  }>("/api/streams/start", async (req, reply) => {
    if (!requireApiKey(req)) return reply.code(401).send({ error: "unauthorized" });

    const { familyId, broadcasterId, broadcasterName, title } = req.body ?? ({} as never);
    if (!familyId || !broadcasterId || !broadcasterName) {
      return reply.code(400).send({ error: "familyId, broadcasterId and broadcasterName are required" });
    }

    for (const s of streams.values()) {
      if (s.familyId === familyId && s.broadcasterId === broadcasterId) {
        streams.delete(s.id);
        broadcast({ type: "stream_ended", payload: { id: s.id, familyId: s.familyId } });
      }
    }

    const id = randomBytes(8).toString("hex");
    const streamKey = randomBytes(12).toString("hex");
    const stream: LiveStream = {
      id,
      streamKey,
      familyId,
      broadcasterId,
      broadcasterName,
      title: title?.trim() || `${broadcasterName} is live`,
      startedAt: Date.now(),
    };
    streams.set(id, stream);

    const dto = toPublicDto(stream);
    broadcast({ type: "stream_started", payload: dto });
    return reply.code(201).send({ data: dto });
  });

  fastify.delete<{
    Params: { streamId: string };
    Body: { broadcasterId?: string };
  }>("/api/streams/:streamId", async (req, reply) => {
    if (!requireApiKey(req)) return reply.code(401).send({ error: "unauthorized" });

    const { streamId } = req.params;
    const broadcasterId = (req.body ?? {}).broadcasterId;
    const stream = streams.get(streamId);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (broadcasterId && stream.broadcasterId !== broadcasterId) {
      return reply.code(403).send({ error: "only the broadcaster can end this stream" });
    }

    streams.delete(streamId);
    broadcast({ type: "stream_ended", payload: { id: stream.id, familyId: stream.familyId } });
    return { data: { ended: true } };
  });

  fastify.get<{ Params: { familyId: string } }>(
    "/api/families/:familyId/streams",
    async (req, reply) => {
      if (!requireApiKey(req)) return reply.code(401).send({ error: "unauthorized" });
      return { data: streamsForFamily(req.params.familyId).map(toPublicDto) };
    },
  );

  fastify.get("/ws/live-streams", { websocket: true }, (socket) => {
    subscribers.add(socket);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        payload: Array.from(streams.values()).map(toPublicDto),
      }),
    );
    socket.on("close", () => subscribers.delete(socket));
    socket.on("error", () => subscribers.delete(socket));
  });

  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`Coordinator listening on :${PORT} (public host ${PUBLIC_HOST})`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
