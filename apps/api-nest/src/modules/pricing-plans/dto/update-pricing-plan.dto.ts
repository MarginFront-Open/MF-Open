import { OmitType, PartialType } from '@nestjs/swagger';
import { CreatePricingPlanDto } from './create-pricing-plan.dto';

// agentId is excluded — plans are linked/unlinked to agents via
// POST /pricing-plans/:id/agents and DELETE /pricing-plans/:id/agents/:agentId
export class UpdatePricingPlanDto extends PartialType(
  OmitType(CreatePricingPlanDto, ['agentId'] as const),
) {}
