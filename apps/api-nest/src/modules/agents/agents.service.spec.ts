import { AgentsService } from './agents.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AgentsService.update', () => {
  it('never moves the agent to another organization, whatever the body carries', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'agent-1' });
    const prisma = { agents: { update } } as unknown as PrismaService;
    const service = new AgentsService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);

    await service.update('agent-1', 'org-1', {
      name: 'Renamed',
      orgId: 'other-org',
      id: 'other-id',
    } as never);

    const { data } = update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data).not.toHaveProperty('orgId');
    expect(data).not.toHaveProperty('id');
  });
});
