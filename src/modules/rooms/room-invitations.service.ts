import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationStatus, RoomStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailQueue } from '../mail/mail.queue';
import { NotificationsService } from '../notifications/notifications.service';
import { RoomsService } from './rooms.service';

/**
 * Invitation window — matches the room's own lifetime intent. If the room
 * ends first, `RoomsService.endRoom` marks any pending invites as EXPIRED
 * so they stop appearing on invitees' dashboards.
 */
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITEES_PER_CALL = 20;

interface InviteInput {
  emails?: string[];
  userIds?: string[];
}

@Injectable()
export class RoomInvitationsService {
  private readonly logger = new Logger(RoomInvitationsService.name);
  private readonly webUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
    private readonly mailQueue: MailQueue,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.webUrl = config
      .get<string>('WEB_URL', 'https://kinoxplus.com')
      .replace(/\/+$/, '');
  }

  /**
   * Host invites a batch of emails and/or userIds. For each invitee:
   *  - if the email matches an existing account → set invitedUserId (push + in-app)
   *  - otherwise → invitedEmail (email with universal link)
   * Duplicates against pending invitations are skipped, not re-sent.
   */
  async createInvitations(roomId: string, hostId: string, input: InviteInput) {
    await this.rooms.assertHost(roomId, hostId);

    const emails = (input.emails ?? []).map((e) => e.trim().toLowerCase());
    const userIds = input.userIds ?? [];
    const total = emails.length + userIds.length;
    if (total === 0) {
      throw new BadRequestException({
        code: 'NO_INVITEES',
        message: 'Provide at least one email or userId.',
      });
    }
    if (total > MAX_INVITEES_PER_CALL) {
      throw new BadRequestException({
        code: 'TOO_MANY_INVITEES',
        message: `Cannot invite more than ${MAX_INVITEES_PER_CALL} people at once.`,
      });
    }

    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        // Title is optional — the room can be in lobby mode with no movie
        // selected. Copy adapts below.
        title: { select: { name: true } },
        host: { select: { displayName: true } },
      },
    });
    if (!room || room.status === RoomStatus.ENDED) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found or already ended.',
      });
    }

    // Validate every provided userId exists. Without this, a bad id here
    // would blow up inside the $transaction below with a cryptic Prisma
    // P2003 (foreign key violation) — turn that into a clean 400.
    if (userIds.length > 0) {
      const existing = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true },
      });
      if (existing.length !== userIds.length) {
        const existingIds = new Set(existing.map((u) => u.id));
        const missing = userIds.filter((id) => !existingIds.has(id));
        throw new BadRequestException({
          code: 'INVITEE_NOT_FOUND',
          message: `Unknown userId(s): ${missing.join(', ')}`,
          missingUserIds: missing,
        });
      }
    }

    // Resolve emails → userId when the email is registered. Attached users
    // get the push+in-app path; unattached emails get the universal-link
    // email path only.
    const usersByEmail = emails.length
      ? await this.prisma.user.findMany({
          where: { email: { in: emails } },
          select: { id: true, email: true, displayName: true },
        })
      : [];
    const emailToUser = new Map(
      usersByEmail
        .filter((u): u is typeof u & { email: string } => u.email !== null)
        .map((u) => [u.email, u]),
    );

    // Prep and dedupe. `userIds` from input are treated as trusted (came
    // from an in-app people-picker). All userIds — resolved-from-email or
    // direct — are unioned.
    const resolvedUserIds = new Set<string>(userIds);
    for (const u of usersByEmail) resolvedUserIds.add(u.id);
    // Emails that DON'T map to an existing account.
    const unresolvedEmails = emails.filter((e) => !emailToUser.has(e));

    // Skip the host themselves — no self-invites.
    resolvedUserIds.delete(hostId);

    // Skip anyone already in the room as active member.
    const alreadyMembers = resolvedUserIds.size
      ? new Set(
          (
            await this.prisma.roomMember.findMany({
              where: {
                roomId,
                userId: { in: Array.from(resolvedUserIds) },
                leftAt: null,
              },
              select: { userId: true },
            })
          ).map((m) => m.userId),
        )
      : new Set<string>();

    // Skip anyone with a still-pending invitation to this room.
    const existingInvites = await this.prisma.roomInvitation.findMany({
      where: {
        roomId,
        status: InvitationStatus.PENDING,
        OR: [
          { invitedUserId: { in: Array.from(resolvedUserIds) } },
          { invitedEmail: { in: unresolvedEmails } },
        ],
      },
      select: { invitedUserId: true, invitedEmail: true },
    });
    const pendingUserIds = new Set(
      existingInvites
        .map((i) => i.invitedUserId)
        .filter((id): id is string => id !== null),
    );
    const pendingEmails = new Set(
      existingInvites
        .map((i) => i.invitedEmail)
        .filter((e): e is string => e !== null),
    );

    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const userIdTargets = Array.from(resolvedUserIds).filter(
      (id) => !alreadyMembers.has(id) && !pendingUserIds.has(id),
    );
    const emailTargets = unresolvedEmails.filter((e) => !pendingEmails.has(e));

    // Batch create — one row per invitee.
    await this.prisma.$transaction([
      ...userIdTargets.map((invitedUserId) =>
        this.prisma.roomInvitation.create({
          data: {
            roomId,
            invitedUserId,
            invitedById: hostId,
            expiresAt,
          },
        }),
      ),
      ...emailTargets.map((invitedEmail) =>
        this.prisma.roomInvitation.create({
          data: {
            roomId,
            invitedEmail,
            invitedById: hostId,
            expiresAt,
          },
        }),
      ),
    ]);

    // Deliver: push to userId invitees, email to everyone.
    const joinUrl = `${this.webUrl}/join/${room.code}`;
    // A title-less room is a valid "lobby" state — the invitation stays
    // meaningful, but the copy has to drop the "watch X together" wording.
    const titleName = room.title?.name ?? null;
    const emailPayload = {
      hostName: room.host.displayName,
      titleName: titleName ?? 'a movie together',
      roomCode: room.code,
      joinUrl,
    };
    const pushBody = titleName
      ? `Come watch ${titleName} together`
      : `Jump in — they'll pick a movie soon`;

    for (const userId of userIdTargets) {
      const user = usersByEmail.find((u) => u.id === userId);
      // Push (device-registered users only — degrades silently if not).
      this.notifications
        .sendToUser(
          userId,
          {
            title: `${room.host.displayName} invited you to a Watch Room`,
            body: pushBody,
          },
          {
            kind: 'room_invite',
            roomId,
            roomCode: room.code,
            ...(titleName ? { titleName } : {}),
            hostName: room.host.displayName,
          },
        )
        .catch((err) =>
          this.logger.error(
            `Failed to send push for invite to ${userId}: ${String(err)}`,
          ),
        );
      // Email — if the user has a registered email address.
      if (user?.email) {
        this.mailQueue
          .queueRoomInvitation({ to: user.email, ...emailPayload })
          .catch((err) =>
            this.logger.error(
              `Failed to queue invite email for ${user.email}: ${String(err)}`,
            ),
          );
      }
    }
    for (const email of emailTargets) {
      this.mailQueue
        .queueRoomInvitation({ to: email, ...emailPayload })
        .catch((err) =>
          this.logger.error(
            `Failed to queue invite email for ${email}: ${String(err)}`,
          ),
        );
    }

    return {
      invited: userIdTargets.length + emailTargets.length,
      skippedAlreadyMembers: alreadyMembers.size,
      skippedAlreadyInvited: pendingUserIds.size + pendingEmails.size,
    };
  }

  /**
   * Dashboard endpoint — every pending invitation for me whose room is
   * still active. Ordered newest-first.
   *
   * Also matches invitations addressed to my email (invitedEmail) with
   * no invitedUserId yet — the case where a friend invited me by email
   * BEFORE I had an account. Once I sign up with that email, those
   * invitations start showing up automatically.
   */
  async listForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const emailFilter = user?.email ? [{ invitedEmail: user.email }] : [];
    return this.prisma.roomInvitation.findMany({
      where: {
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
        room: { status: { not: RoomStatus.ENDED } },
        OR: [{ invitedUserId: userId }, ...emailFilter],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        room: {
          select: {
            id: true,
            code: true,
            status: true,
            isPrivate: true,
            maxMembers: true,
            title: {
              select: {
                id: true,
                name: true,
                slug: true,
                posterUrl: true,
                backdropUrl: true,
              },
            },
            host: {
              select: {
                id: true,
                displayName: true,
                username: true,
                avatarUrl: true,
                avatarColor: true,
              },
            },
          },
        },
      },
    });
  }

  async decline(invitationId: string, userId: string): Promise<void> {
    // Also allow declining email-only invitations that haven't been
    // linked yet — the invitee owns the email and can act on them.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const emailFilter = user?.email ? [{ invitedEmail: user.email }] : [];
    const result = await this.prisma.roomInvitation.updateMany({
      where: {
        id: invitationId,
        status: InvitationStatus.PENDING,
        OR: [{ invitedUserId: userId }, ...emailFilter],
      },
      data: { status: InvitationStatus.DECLINED },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation not found or already actioned.',
      });
    }
  }
}
