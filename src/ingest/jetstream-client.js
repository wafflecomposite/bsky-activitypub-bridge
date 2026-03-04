export class JetstreamClient {
  #processor;
  #state;
  #shardId;
  #jetstreamUrl;
  #wantedCollections;
  #wantedDids;
  #wantedDidSet;
  #requireWantedDids;
  #reconnectDelayMs;
  #rewindSeconds;
  #WebSocketImpl;
  #timers;
  #running = false;
  #ws = null;
  #reconnectTimer = null;

  constructor({
    processor,
    state,
    shardId = "default",
    jetstreamUrl,
    wantedCollections = ["app.bsky.feed.post"],
    wantedDids = [],
    requireWantedDids = true,
    reconnectDelayMs = 1000,
    rewindSeconds = 5,
    WebSocketImpl = WebSocket,
    timers = globalThis
  }) {
    if (!processor || typeof processor.process !== "function") {
      throw new Error("JetstreamClient requires a processor with a process(event) method");
    }

    if (!state || typeof state.getCursor !== "function") {
      throw new Error("JetstreamClient requires a state object with getCursor(shardId)");
    }

    if (typeof WebSocketImpl !== "function") {
      throw new Error("JetstreamClient requires a WebSocket implementation");
    }

    this.#processor = processor;
    this.#state = state;
    this.#shardId = shardId;
    this.#jetstreamUrl = jetstreamUrl ?? "wss://jetstream1.us-east.bsky.network/subscribe";
    this.#wantedCollections = [...wantedCollections];
    this.#wantedDids = normalizeWantedDids(wantedDids);
    this.#wantedDidSet = new Set(this.#wantedDids);
    this.#requireWantedDids = requireWantedDids;
    this.#reconnectDelayMs = reconnectDelayMs;
    this.#rewindSeconds = rewindSeconds;
    this.#WebSocketImpl = WebSocketImpl;
    this.#timers = timers;
  }

  start() {
    if (this.#running) {
      return;
    }

    this.#running = true;
    if (this.#canConnect()) {
      this.#connect();
    }
  }

  stop() {
    this.#running = false;

    if (this.#reconnectTimer) {
      this.#timers.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  setWantedDids(nextWantedDids) {
    this.#wantedDids = normalizeWantedDids(nextWantedDids);
    this.#wantedDidSet = new Set(this.#wantedDids);

    if (!this.#running) {
      return;
    }

    if (!this.#canConnect()) {
      if (this.#reconnectTimer) {
        this.#timers.clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
      }

      if (this.#ws) {
        this.#ws.close();
        this.#ws = null;
      }
      return;
    }

    if (!this.#ws || this.#ws.readyState !== this.#WebSocketImpl.OPEN) {
      this.#connect();
      return;
    }

    this.#ws.send(JSON.stringify({
      type: "options_update",
      payload: {
        wantedDids: this.#wantedDids
      }
    }));
  }

  getCurrentConnectionUrl() {
    return this.#ws?.url ?? null;
  }

  getWantedDidCount() {
    return this.#wantedDids.length;
  }

  #connect() {
    if (!this.#running || !this.#canConnect()) {
      return;
    }

    if (this.#ws && this.#ws.readyState === this.#WebSocketImpl.OPEN) {
      return;
    }

    const url = buildJetstreamSubscribeUrl({
      jetstreamUrl: this.#jetstreamUrl,
      cursor: this.#state.getCursor(this.#shardId),
      rewindSeconds: this.#rewindSeconds,
      wantedCollections: this.#wantedCollections,
      wantedDids: this.#wantedDids
    });

    const ws = new this.#WebSocketImpl(url);
    this.#ws = ws;

    ws.onmessage = (event) => {
      this.#handleMessage(event);
    };

    ws.onclose = () => {
      this.#handleDisconnect();
    };

    ws.onerror = () => {
      this.#handleDisconnect();
    };
  }

  #handleMessage(event) {
    let parsed;
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString("utf-8");
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed?.type === "options_update" || parsed?.type === "options_update_ack") {
      return;
    }

    if (this.#requireWantedDids && this.#wantedDidSet.size === 0) {
      return;
    }

    if (typeof parsed?.did === "string" && this.#wantedDidSet.size > 0 && !this.#wantedDidSet.has(parsed.did)) {
      return;
    }

    this.#processor.process(parsed);
  }

  #handleDisconnect() {
    if (!this.#running) {
      return;
    }

    if (!this.#canConnect()) {
      return;
    }

    if (this.#reconnectTimer) {
      return;
    }

    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#reconnectDelayMs);
  }

  #canConnect() {
    return !this.#requireWantedDids || this.#wantedDids.length > 0;
  }
}

export function buildJetstreamSubscribeUrl({ jetstreamUrl, cursor, rewindSeconds, wantedCollections, wantedDids }) {
  const url = new URL(jetstreamUrl);

  for (const collection of wantedCollections) {
    url.searchParams.append("wantedCollections", collection);
  }

  for (const did of wantedDids) {
    url.searchParams.append("wantedDids", did);
  }

  if (typeof cursor === "number" && Number.isFinite(cursor)) {
    const rewind = Math.max(0, rewindSeconds) * 1_000_000;
    const rewoundCursor = Math.max(0, cursor - rewind);
    url.searchParams.set("cursor", String(rewoundCursor));
  }

  return url.toString();
}

function normalizeWantedDids(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values
    .filter((did) => typeof did === "string" && did.trim())
    .map((did) => did.trim()))]
    .sort();
}
