import { UsersService } from './users.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('UsersService.updateCurrentUser', () => {
  it('writes only the name and persona, whatever else the body carries', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'user-1' });
    const prisma = {
      users: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', email: 'me@example.com' }),
        update,
      },
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    const body = {
      name: 'New Name',
      persona: 'finance',
      email: 'someone-else@example.com',
      isEmailVerified: true,
      role: 'admin',
      organizationId: 'other-org',
    };
    await service.updateCurrentUser('user-1', body as never);

    const { data } = update.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual(['name', 'persona', 'updatedAt']);
    expect(data.name).toBe('New Name');
    expect(data.persona).toBe('finance');
  });
});
