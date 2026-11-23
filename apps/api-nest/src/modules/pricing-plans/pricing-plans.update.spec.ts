import { PricingPlansService } from './pricing-plans.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('PricingPlansService.update', () => {
  it('never moves the plan to another organization, whatever the body carries', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'plan-1' });
    const prisma = { pricing_plans: { update } } as unknown as PrismaService;
    const service = new PricingPlansService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);

    await service.update('plan-1', 'org-1', {
      name: 'Renamed',
      organizationId: 'other-org',
      id: 'other-id',
    } as never);

    const { data } = update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data).not.toHaveProperty('organizationId');
    expect(data).not.toHaveProperty('id');
  });
});
