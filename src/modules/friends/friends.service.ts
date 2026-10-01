import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendRequestStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const PUBLIC_FRIEND_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
} as const;

/** Default page size for the friends list surfaces. Capped at 100. */
const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Send a friend request to the target user, looked up by username.
   *  Side effects: fires a push + in-app notification to the receiver, and
   *  if there's already a declined request from the sender, replaces it
   *  (so a user who declined once can be asked again later). */
  async sendRequest(senderId: string, targetUsername: string) {
    const [sender, target] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: senderId },
        select: { displayName: true },
      }),
      this.prisma.user.findUnique({
        where: { username: targetUsername.toLowerCase() },
        select: { id: true, displayName: true },
      }),
    ]);
    if (!target) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'No account with that username.',
      });
    }
    if (target.id === senderId) {
      throw new BadRequestException({
        code: 'CANNOT_FRIEND_SELF',
        message: 'You cannot add yourself as a friend.',
      });
    }

    // If the other party already sent you a request, accept it instead of
    // creating a parallel pending row. "Add" after someone already
    // requested you reads to the user as mutual accept.
    const theirRequest = await this.prisma.friendRequest.findUnique({
      where: {
        senderId_receiverId: { senderId: target.id, receiverId: senderId },
      },
    });
    if (theirRequest && theirRequest.status === FriendRequestStatus.PENDING) {
      return this.respond(senderId, theirRequest.id, 'accept');
    }

    // Replace a prior DECLINED row from me so the user can re-ask after
    // being declined. Without this, the unique (senderId, receiverId)
    // constraint locks the pair into "declined forever" from day one.
    const mine = await this.prisma.friendRequest.findUnique({
      where: {
        senderId_receiverId: { senderId, receiverId: target.id },
      },
    });
    if (mine && mine.status === FriendRequestStatus.DECLINED) {
      await this.prisma.friendRequest.delete({ where: { id: mine.id } });
    } else if (mine) {
      // PENDING already from me, or ACCEPTED already — surface what it is.
      throw new ConflictException({
        code:
          mine.status === FriendRequestStatus.ACCEPTED
            ? 'ALREADY_FRIENDS'
            : 'REQUEST_ALREADY_SENT',
        message:
          mine.status === FriendRequestStatus.ACCEPTED
            ? 'You are already friends with this user.'
            : 'You already sent a friend request to this user.',
      });
    }

    const created = await this.prisma.friendRequest.create({
      data: { senderId, receiverId: target.id },
      include: {
        sender: { select: PUBLIC_FRIEND_SELECT },
        receiver: { select: PUBLIC_FRIEND_SELECT },
      },
    });

    // Fire-and-forget notification to the receiver. Any failure here must
    // not undo the DB write — the request still exists in the Friends tab.
    this.notifications
      .sendToUser(
        target.id,
        {
          title: 'New friend request',
          body: `${sender?.displayName ?? 'Someone'} sent you a friend request.`,
          kind: 'friend_request_received',
        },
        { kind: 'friend_request_received', requestId: created.id },
      )
      .catch((error) =>
        this.logger.warn(
          `Friend request push failed for ${target.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

    return created;
  }

  /** Pending incoming requests, cursor-paginated newest first. */
  async listIncoming(userId: string, cursor?: string, limit?: number) {
    const take = Math.min(limit ?? DEFAULT_PAGE_SIZE, 100);
    const rows = await this.prisma.friendRequest.findMany({
      where: { receiverId: userId, status: FriendRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { sender: { select: PUBLIC_FRIEND_SELECT } },
    });
    return this.paginate(rows, take);
  }

  /** Pending outgoing requests, cursor-paginated newest first. */
  async listOutgoing(userId: string, cursor?: string, limit?: number) {
    const take = Math.min(limit ?? DEFAULT_PAGE_SIZE, 100);
    const rows = await this.prisma.friendRequest.findMany({
      where: { senderId: userId, status: FriendRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { receiver: { select: PUBLIC_FRIEND_SELECT } },
    });
    return this.paginate(rows, take);
  }

  /** Accepted friends — both directions. Returns the OTHER user, not the
   *  FriendRequest row, so clients render a simple list of people. */
  async listFriends(userId: string, cursor?: string, limit?: number) {
    const take = Math.min(limit ?? DEFAULT_PAGE_SIZE, 100);
    const rows = await this.prisma.friendRequest.findMany({
      where: {
        status: FriendRequestStatus.ACCEPTED,
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
      // respondedAt is set on every accepted row, but we tie-break on id
      // so the cursor remains deterministic when two accepts share a ms.
      orderBy: [{ respondedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        sender: { select: PUBLIC_FRIEND_SELECT },
        receiver: { select: PUBLIC_FRIEND_SELECT },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      data: page.map((row) =>
        row.senderId === userId ? row.receiver : row.sender,
      ),
      meta: {
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  private paginate<T extends { id: string }>(rows: T[], take: number) {
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      data: page,
      meta: {
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  /** Current number of accepted friends — used by the profile stats row. */
  friendCount(userId: string): Promise<number> {
    return this.prisma.friendRequest.count({
      where: {
        status: FriendRequestStatus.ACCEPTED,
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
    });
  }

  /** Accept or decline a pending request. Only the receiver can respond. */
  async respond(
    userId: string,
    requestId: string,
    action: 'accept' | 'decline',
  ) {
    const existing = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });
    if (!existing || existing.receiverId !== userId) {
      throw new NotFoundException({
        code: 'REQUEST_NOT_FOUND',
        message: 'No pending friend request with that id.',
      });
    }
    if (existing.status !== FriendRequestStatus.PENDING) {
      throw new ConflictException({
        code: 'REQUEST_ALREADY_RESPONDED',
        message: 'This request has already been handled.',
      });
    }
    const updated = await this.prisma.friendRequest.update({
      where: { id: requestId },
      data: {
        status:
          action === 'accept'
            ? FriendRequestStatus.ACCEPTED
            : FriendRequestStatus.DECLINED,
        respondedAt: new Date(),
      },
      include: {
        sender: { select: PUBLIC_FRIEND_SELECT },
        receiver: { select: PUBLIC_FRIEND_SELECT },
      },
    });

    // Only tell the requester on accept — a decline notification would be
    // awkward and spammy. Fire-and-forget; a failed push doesn't roll back
    // the friendship itself.
    if (action === 'accept') {
      this.notifications
        .sendToUser(
          existing.senderId,
          {
            title: 'Friend request accepted',
            body: `${updated.receiver.displayName} accepted your friend request.`,
            kind: 'friend_request_accepted',
          },
          {
            kind: 'friend_request_accepted',
            userId: existing.receiverId,
          },
        )
        .catch((error) =>
          this.logger.warn(
            `Friend accept push failed for ${existing.senderId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }

    return updated;
  }

  /** Cancel a pending outgoing request. Only the sender can cancel. */
  async cancel(userId: string, requestId: string) {
    const existing = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });
    if (!existing || existing.senderId !== userId) {
      throw new NotFoundException({
        code: 'REQUEST_NOT_FOUND',
        message: 'No outgoing friend request with that id.',
      });
    }
    await this.prisma.friendRequest.delete({ where: { id: requestId } });
    return { cancelled: true };
  }

  /** Remove the mutual friendship with the target user. Deletes whichever
   *  direction the ACCEPTED row sits in. */
  async unfriend(userId: string, targetUserId: string) {
    const deleted = await this.prisma.friendRequest.deleteMany({
      where: {
        status: FriendRequestStatus.ACCEPTED,
        OR: [
          { senderId: userId, receiverId: targetUserId },
          { senderId: targetUserId, receiverId: userId },
        ],
      },
    });
    if (deleted.count === 0) {
      throw new NotFoundException({
        code: 'NOT_FRIENDS',
        message: 'You are not friends with this user.',
      });
    }
    return { unfriended: true };
  }
}
