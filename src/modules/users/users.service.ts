import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  uniqueViolationTarget,
} from '../../common/utils/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';

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
  constructor(private readonly prisma: PrismaService) {}

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
