import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgFromUser, OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';
import { CreditPoolService } from './credit-pool.service';
import { CreateCreditTopupDto, CreditAlertsPauseDto, QueryCreditBalancesDto } from './dto';

/**
 * The programmatic half of credit-pool
 * visibility. Reads carry no per-route role gate, so every role from member up
 * can call them; the two writes are owner/admin/finance only, the same
 * MANAGE_MONEY_ROLES gate every other books write carries.
 *
 * An EXPLICIT ingest-role key gets a 403 here from IngestKeyScopeGuard: these
 * reads are not on its eight-handler allowlist. GET /control/coverage IS
 * allowlisted (the on-device brake reads it with the ingest key it sends usage
 * with); these balances are not.
 *
 * Track-only: none of this stops anything. A pool at zero keeps serving and
 * the overage bills at period close.
 */
@ApiTags('Credit Pools')
@Controller()
@UseGuards(CombinedAuthGuard)
@ApiSecurity('api-key')
export class CreditPoolController {
  constructor(private readonly creditPool: CreditPoolService) {}

  /** The actor recorded on a grant. Deliberately NOT getUserId(): that helper
   * flattens every API key to one 'system:api-key' sentinel, and the ledger is
   * the only audit trail a top-up gets, so it records WHICH key. */
  private actorFor(user: { authMethod?: string; userId?: string; apiKeyId?: string }): string {
    if (user?.authMethod === 'api-key') {
      return user.apiKeyId ? `api-key:${user.apiKeyId}` : 'system:api-key';
    }
    return user?.userId ?? 'system:unknown';
  }

  @Get('credit-balances')
  // Cheap and cacheable: pool balances move at ingest speed, a short private
  // cache smooths repeated polling, and the response carries asOf regardless.
  @Header('Cache-Control', 'private, max-age=30')
  @ApiOperation({
    summary: 'Credit-pool balances for the organization',
    description:
      'One row per credit-pool subscription: pool size, units used this period, units left, ' +
      'and units already billing as overage. Two numbers are deliberately different and both ' +
      "are true: remainingUnits counts top-ups, overageInProgressUnits is the invoice's own " +
      'math (usage past the pool size, top-up blind), so a topped-up pool can show units left ' +
      'AND overage at the same time. Nothing stops at zero: the pool is a meter, not a breaker, ' +
      'and the overage keeps billing. periodStart/periodEnd are null when the subscription has ' +
      'no billing period yet (honest absence, never a made-up window). Read-only. Every key ' +
      'role except ingest-only can call it; an ingest-only key gets a 403. Same numbers the ' +
      'dashboard shows: one shared balance path.',
  })
  @ApiResponse({ status: 200, description: 'Credit-pool balances' })
  async listBalances(@Req() req: any, @Query() query: QueryCreditBalancesDto) {
    return this.creditPool.listBalances(req.user.organizationId, {
      customerId: query.customerId,
      agentId: query.agentId,
      belowPercent: query.belowPercent,
    });
  }

  @Get('subscriptions/:id/credit-balance')
  @Header('Cache-Control', 'private, max-age=30')
  @ApiOperation({
    summary: 'Credit-pool balance for one subscription',
    description:
      'The same row GET /v1/credit-balances returns, for a single subscription. 404 when the ' +
      "subscription isn't in this organization or its plan doesn't sell a credit pool — a " +
      'subscription without a pool has no pool number, never a zero one. Read-only. Every ' +
      'key role except ingest-only can call it; an ingest-only key gets a 403.',
  })
  @ApiResponse({ status: 200, description: 'The credit-pool balance' })
  @ApiResponse({ status: 404, description: 'No credit pool on that subscription' })
  async getBalance(@Req() req: any, @Param('id') id: string) {
    return this.creditPool.getBalance(req.user.organizationId, id);
  }

  @Post('subscriptions/:id/credit-topup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add units to a credit pool',
    description:
      'Owner, admin, or finance only. Adds usage units that never expire — the customer paid ' +
      'for them, and draw order burns the current period grant first anyway. idempotencyKey is ' +
      'required: send the same key twice and the SAME grant comes back, so a retry can never ' +
      'double-credit. The grant row itself is the audit trail (who added the units, plus your ' +
      'note). A top-up raises units left; it does NOT reduce overage already recorded this ' +
      'period, because the invoice never saw the top-up.',
  })
  @ApiResponse({ status: 201, description: 'Units added (or the original grant re-returned)' })
  @ApiResponse({ status: 400, description: "The subscription's plan sells no credit pool" })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  @ApiResponse({ status: 404, description: 'Subscription not found in this organization' })
  @ApiResponse({ status: 409, description: 'That key already topped up a different subscription' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async createTopup(@Req() req: any, @Param('id') id: string, @Body() dto: CreateCreditTopupDto) {
    const result = await this.creditPool.createTopup(
      req.user.organizationId,
      id,
      this.actorFor(req.user),
      { units: dto.units, idempotencyKey: dto.idempotencyKey, note: dto.note },
    );
    return result;
  }

  @Post('subscriptions/:id/credit-alerts-pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause or resume credit-pool alert emails',
    description:
      'Owner, admin, or finance only. Send the state you want: {"paused": true} silences this ' +
      'subscription\'s pool emails, {"paused": false} turns them back on. Idempotent — two ' +
      'identical calls leave the subscription in the same place. Pausing changes emails only: ' +
      'the pool keeps counting down and the balance stays visible everywhere.',
  })
  @ApiResponse({ status: 200, description: 'The resulting alert state' })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  @ApiResponse({ status: 404, description: 'Subscription not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async setAlertsPaused(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: CreditAlertsPauseDto,
  ) {
    const result = await this.creditPool.setAlertsPaused(req.user.organizationId, id, dto.paused);
    return result;
  }
}
