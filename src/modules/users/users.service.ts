import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  uniqueViolationTarget,
} from '../../common/utils/prisma-errors';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';

// Accept anything a phone camera can produce. HEIC/HEIF from iOS gets
// auto-converted by Cloudinary's transformation pipeline into fetch_format:auto
// (usually WebP), so the stored asset is web-compatible regardless of upload.
const ALLOWED_AVATAR_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
  bio: true,
  dateOfBirth: true,
  preferredGenres: true,
  role: true,
  emailVerified: true,
  phoneVerified: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Uploads a fresh avatar to Cloudinary and saves the resulting URL on the
   * user. Old avatars aren't deleted from Cloudinary yet — that's a
   * cleanup-job follow-up. Wire negligible until we're at real scale.
   */
  async uploadAvatar(userId: string, file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException({
        code: 'NO_FILE',
        message: 'Provide an image file under the "file" field.',
      });
    }
    if (!ALLOWED_AVATAR_MIME.test(file.mimetype)) {
      throw new BadRequestException({
        code: 'INVALID_FILE_TYPE',
        message: 'Avatar must be a JPEG, PNG, WebP, GIF, or HEIC image.',
      });
    }
    if (!this.cloudinary.isConfigured) {
      // The service will throw too, but this gives a clearer 503-style
      // signal than a generic 500 during local dev without envs.
      throw new BadRequestException({
        code: 'UPLOADS_NOT_CONFIGURED',
        message: 'Image uploads are not configured on this environment.',
      });
    }

    const result = await this.cloudinary.uploadImage(file.buffer, 'avatars');
    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: result.secure_url },
      select: PUBLIC_USER_SELECT,
    });
  }

  async removeAvatar(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
      select: PUBLIC_USER_SELECT,
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }
    return user;
  }

  updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user
      .update({
        where: { id: userId },
        data: dto,
        select: PUBLIC_USER_SELECT,
      })
      .catch((err: unknown) => {
        if (
          isUniqueViolation(err) &&
          uniqueViolationTarget(err).includes('username')
        ) {
          throw new ConflictException({
            code: 'USERNAME_TAKEN',
            message: 'This username is already taken.',
          });
        }
        throw err;
      });
  }
}
