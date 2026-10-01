import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { RoomStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../queues';

/** Job name — enqueued on room create when the host's plan has a session cap. */
export const ROOM_SESSION_CAP_JOB = 'room:session-cap';

export interface RoomSessionCapPayload {
  roomId: string;
}

/**
 * Enforces the host's plan session-length cap. Runs at the cap boundary
 * (delayed job). If the room is still LOBBY/PLAYING/PAUSED, mark it ENDED
 * and let normal cleanup / sockets fan out. Jobs are idempotent — a room
 * that already ended naturally is left alone.
 */
@Processor(QUEUES.ROOMS)
export class RoomsProcessor extends WorkerHost {
  private readonly logger = new Logger(RoomsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<RoomSessionCapPayload>): Promise<void> {
    if (job.name !== ROOM_SESSION_CAP_JOB) return;
    const { roomId } = job.data;
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, status: true },
    });
    if (!room || room.status === RoomStatus.ENDED) {
      // Already ended on its own — nothing to do.
      return;
    }
    await this.prisma.room.update({
      where: { id: roomId },
      data: { status: RoomStatus.ENDED, endedAt: new Date() },
    });
    this.logger.log(
      `Room ${roomId} ended by session-cap job (host plan limit reached).`,
    );
  }
}
