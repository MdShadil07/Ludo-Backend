type RedisClientLike = {
  connect: () => Promise<void>;
  quit: () => Promise<void>;
  on: (event: string, cb: (...args: any[]) => void) => void;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: Record<string, unknown>) => Promise<unknown>;
  lPush: (key: string, value: string) => Promise<unknown>;
  lTrim: (key: string, start: number, stop: number) => Promise<unknown>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

type RedisModuleLike = {
  createClient: (opts: { url: string }) => RedisClientLike;
};

export class RedisCache {
  private client: RedisClientLike | null = null;
  private ready = false;

  async init(): Promise<void> {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) return;

    try {
      // Optional dependency at runtime. If not installed, we gracefully degrade to memory-only cache.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const redisModule = require("redis") as RedisModuleLike;
      this.client = redisModule.createClient({ url: redisUrl });
      this.client.on("error", (err: unknown) => {
        console.error("[redis] client error:", err);
      });
      await this.client.connect();
      this.ready = true;
      console.log("[redis] connected");
    } catch (error) {
      this.client = null;
      this.ready = false;
      console.warn("[redis] disabled (package missing or connection failed):", error);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.client || !this.ready) return;
    try {
      await this.client.quit();
    } catch (error) {
      console.error("[redis] shutdown error:", error);
    } finally {
      this.client = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && !!this.client;
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client || !this.ready) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      console.error("[redis] getJson error:", error);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.ready) return;
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, serialized, { EX: ttlSeconds });
      } else {
        await this.client.set(key, serialized);
      }
    } catch (error) {
      console.error("[redis] setJson error:", error);
    }
  }

  async pushLog(key: string, entry: unknown, maxItems: number, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.ready) return;
    try {
      await this.client.lPush(key, JSON.stringify(entry));
      await this.client.lTrim(key, 0, Math.max(0, maxItems - 1));
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.expire(key, ttlSeconds);
      }
    } catch (error) {
      console.error("[redis] pushLog error:", error);
    }
  }
}

