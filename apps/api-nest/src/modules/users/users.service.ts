import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentUser(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isEmailVerified: true,
        status: true,
        organizationId: true,
        current_organization_id: true,
        google_id: true,
        auth_provider: true,
        persona: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      success: true,
      data: user,
    };
  }

  async updateCurrentUser(userId: string, updateUserDto: UpdateUserDto) {
    const existingUser = await this.prisma.users.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.users.update({
      where: { id: userId },
      data: {
        name: updateUserDto.name,
        persona: updateUserDto.persona,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isEmailVerified: true,
        status: true,
        organizationId: true,
        current_organization_id: true,
        google_id: true,
        auth_provider: true,
        persona: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser,
    };
  }
}
