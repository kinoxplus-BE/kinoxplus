import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.io adapter backed by Redis pub/sub so room events fan out across
 * every API instance — mandatory for multi-instance deploys (AGENTS.md §6).
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  async connectToRedis(url: string): Promise<void> {
    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Compress WebSocket frames >1KB. Every chat message, sync:state
    // broadcast, and heartbeat gets deflated — on slow mobile networks
    // this is the difference between a smooth room and dropped frames.
    // Threshold matches our HTTP compression to avoid CPU on tiny messages.
    const optionsWithCompression: ServerOptions = {
      ...(options ?? ({} as ServerOptions)),
      perMessageDeflate: {
        threshold: 1024,
      },
    };
    const server = super.createIOServer(port, optionsWithCompression) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
