import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  CAP_MANAGE_ROLES,
  MANAGE_MONEY_ROLES,
  buildCapSentence,
  toNumber,
  type CapPeriod,
  type CapScope,
} from '@marginfront/db';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgFromUser, OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';
import { IngestKeyAllowed } from '../../common/guards/ingest-key-scope.guard';
import { CostControlService } from './cost-control.service';
import { CreateCapPolicyDto } from './dto/create-cap-policy.dto';
import { UpdateCapPolicyDto } from './dto/update-cap-policy.dto';
import { QuerySpendDto } from './dto/query-spend.dto';
import { CoverageResponseDto } from './dto/coverage-response.dto';
import { QuerySpendBreakdownDto } from './dto/query-spend-breakdown.dto';
import { QuerySpendDrillDto } from './dto/query-spend-drill.dto';

/**
 * The server half of spend caps. Two jobs:
 * store cap policies (writes are owner/finance-only with an audit trail) and
 * serve the spend read-back the device brake reads. There is NO server-side
 * enforcement here; the brake lives on the developer's machine and fails open.
 *
 * READ POSTURE: a publishable key is
 * refused on all five GETs — by the global deny-by-default in
 * PublishableKeyReadGuard, no per-route decorator needed.
 * breakdown + drill also demand MANAGE_MONEY_ROLES (they expose per-repo/branch
 * spend and teammate emails; the internal-ai-spend page, their only human
 * consumer, gates on the same set). caps/spend/coverage carry NO role gate: the
 * on-device brake polls caps + spend every 5 minutes with a developer-role key
 * and stops enforcing when its state goes stale, so a role gate here silently
 * disarms every customer's cap an hour after deploy. Reads take MANAGE_MONEY_ROLES
 * while writes keep the deliberately narrower CAP_MANAGE_ROLES (no admin): an
 * admin may read a cap but not write one — do not "harmonize" the two sets.
 */
@ApiTags('Cost Control')
@Controller('control')
@UseGuards(CombinedAuthGuard)
@ApiSecurity('api-key')
export class CostControlController {
  constructor(private readonly costControlService: CostControlService) {}

  /**
   * The cap as its one plain sentence, built from the shared @marginfront/db rule so
   * every programmatic write echoes IDENTICAL wording (reuse the
   * sentence rule, never re-derive). Response-shaping only; the service returns
   * pure domain rows so its unit specs are untouched.
   */
  private capSentence(cap: {
    providerScope: string;
    amountUsd: unknown;
    scope: string;
    scopeValue: string | null;
    period: string;
  }): string {
    return buildCapSentence({
      providerScope: cap.providerScope,
      amountUsd: toNumber(cap.amountUsd),
      scope: cap.scope as CapScope,
      scopeValue: cap.scopeValue,
      period: cap.period as CapPeriod,
    });
  }

  /**
   * A cap row as clean JSON for a programmatic caller: amountUsd as an honest
   * number (a raw Prisma Decimal serializes to a STRING over the wire — the same
   * toNumber convention every other money read uses), plus the plain sentence.
   * The service still returns Decimal rows; this shaping lives at the boundary so
   * the SDK/MCP get a typed, number-valued contract.
   */
  private serializeCap(cap: {
    id: string;
    scope: string;
    scopeValue: string | null;
    providerScope: string;
    amountUsd: unknown;
    period: string;
    mode: string;
    coolOffHours: number | null;
    alertThresholds: number[];
    createdByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: cap.id,
      scope: cap.scope,
      scopeValue: cap.scopeValue,
      providerScope: cap.providerScope,
      amountUsd: toNumber(cap.amountUsd),
      period: cap.period,
      mode: cap.mode,
      coolOffHours: cap.coolOffHours,
      alertThresholds: cap.alertThresholds,
      createdByUserId: cap.createdByUserId,
      createdAt: cap.createdAt,
      updatedAt: cap.updatedAt,
      sentence: this.capSentence(cap),
    };
  }

  @Get('caps')
  // No OrgRoleGuard on purpose: a role gate here silently disarms the device brake in
  // the field — see the class doc READ POSTURE.
  // Same device-brake reason against the global ingest-role deny. Every meter
  // polls this route with an ingest key; a 403 here disarms every deployed
  // cap about an hour later, when the brake's state goes stale.
  @IngestKeyAllowed()
  @ApiOperation({ summary: 'List cap policies for the organization' })
  @ApiResponse({ status: 200, description: 'Cap policies retrieved' })
  @ApiResponse({
    status: 403,
    description: 'Publishable keys cannot read cap policies. Use a secret key.',
  })
  async listCaps(@Req() req: any) {
    const caps = await this.costControlService.listCaps(req.user.organizationId);
    return caps.map((cap) => this.serializeCap(cap));
  }

  @Post('caps')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a cap policy',
    description:
      'Owner/finance only. A team or dev cap can never exceed the org ceiling for the ' +
      'same provider (enforced in the shared validation path). Every write is audited.',
  })
  @ApiResponse({ status: 201, description: 'Cap policy created' })
  @ApiResponse({
    status: 400,
    description: 'Cap exceeds the org ceiling, or scope/scopeValue mismatch',
  })
  @ApiResponse({ status: 403, description: 'Caller is not owner/finance' })
  @ApiResponse({
    status: 409,
    description: 'A cap with this scope, target, and provider already exists',
  })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...CAP_MANAGE_ROLES)
  @OrgFromUser()
  async createCap(@Req() req: any, @Body() dto: CreateCapPolicyDto) {
    const cap = await this.costControlService.createCap(
      req.user.organizationId,
      req.user.userId,
      dto,
    );
    return this.serializeCap(cap);
  }

  @Patch('caps/:id')
  @ApiOperation({
    summary: 'Update a cap policy',
    description:
      'Owner/finance only. Adjusts amount / period / mode / cool-off on an existing cap.',
  })
  @ApiResponse({ status: 200, description: 'Cap policy updated' })
  @ApiResponse({ status: 400, description: 'New amount would break the ceiling rule' })
  @ApiResponse({ status: 403, description: 'Caller is not owner/finance' })
  @ApiResponse({ status: 404, description: 'Cap policy not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...CAP_MANAGE_ROLES)
  @OrgFromUser()
  async updateCap(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCapPolicyDto) {
    const cap = await this.costControlService.updateCap(
      req.user.organizationId,
      id,
      req.user.userId,
      dto,
    );
    return this.serializeCap(cap);
  }

  @Delete('caps/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a cap policy', description: 'Owner/finance only. Audited.' })
  @ApiResponse({ status: 200, description: 'Cap policy deleted' })
  @ApiResponse({
    status: 400,
    description: "Deleting this org ceiling would leave a child cap above the 'all' fallback",
  })
  @ApiResponse({ status: 403, description: 'Caller is not owner/finance' })
  @ApiResponse({ status: 404, description: 'Cap policy not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...CAP_MANAGE_ROLES)
  @OrgFromUser()
  async deleteCap(@Req() req: any, @Param('id') id: string) {
    const result = await this.costControlService.deleteCap(
      req.user.organizationId,
      id,
      req.user.userId,
    );
    return { deleted: result.deleted, sentence: this.capSentence(result.cap) };
  }

  @Get('spend')
  // Cheap and cacheable: a short private cache smooths a fleet of daemons polling
  // the same org without staling the number past a device poll cycle. The response
  // carries asOf so the caller sees freshness regardless of the cache.
  @Header('Cache-Control', 'private, max-age=30')
  // No OrgRoleGuard on purpose: same device-brake reason as /caps — see the class doc.
  // The brake filters to enforce-mode all-provider caps first, so this is called
  // with the same ingest key as soon as an org has one.
  @IngestKeyAllowed()
  @ApiOperation({
    summary: 'Spend read-back for the device brake',
    description:
      "Returns the org total and (when customerExternalId is given) that dev's spend for the " +
      'current period. Fail-open by contract: spentUsd is null when there is no priced usage, ' +
      'and the device treats null / stale / unreachable as no-block.',
  })
  @ApiResponse({ status: 200, description: 'Spend totals for the period' })
  @ApiResponse({
    status: 403,
    description: 'Publishable keys cannot read spend. Use a secret key.',
  })
  async getSpend(@Req() req: any, @Query() query: QuerySpendDto) {
    return this.costControlService.getSpendReadback(req.user.organizationId, query);
  }

  @Get('spend/breakdown')
  // Same short private cache as /spend: the numbers move at ingest speed, and
  // the response carries asOf regardless.
  @Header('Cache-Control', 'private, max-age=30')
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  // @OrgFromUser is load-bearing: @Controller('control') carries no :orgId/:id param,
  // so without it OrgRoleGuard resolves orgId as undefined and 403s EVERY caller.
  @OrgFromUser()
  @ApiOperation({
    summary: 'Internal AI spend for the current period, by repo or branch',
    description:
      'Rolls up internal coding-agent spend (Claude Code and Codex events only, never ' +
      'customer billing) for the current period, grouped by the git repo or branch each ' +
      'event was recorded on. Branch is the closest honest stand-in for a pull request: ' +
      'the platform records repo, branch, and commit on each event, not PR numbers. ' +
      'Events with no repo or branch recorded (events sent without git data, ' +
      'or work outside a git checkout) land in the explicit noMetadata bucket and ' +
      'coveragePercent states how much of the activity carries the key. spentUsd is null ' +
      'wherever there is no priced usage, never a made-up zero.',
  })
  @ApiResponse({ status: 200, description: 'Spend rows for the chosen grouping' })
  @ApiResponse({
    status: 403,
    description:
      'Publishable keys cannot read the spend breakdown (use a secret key), and the ' +
      'caller must be owner, admin, or finance.',
  })
  async getSpendBreakdown(@Req() req: any, @Query() query: QuerySpendBreakdownDto) {
    return this.costControlService.getSpendBreakdown(req.user.organizationId, query);
  }

  @Get('spend/breakdown/drill')
  // Same short private cache as /spend/breakdown: the numbers move at ingest
  // speed, and the response carries asOf regardless.
  @Header('Cache-Control', 'private, max-age=30')
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  // @OrgFromUser is load-bearing here too — same reason as /spend/breakdown.
  @OrgFromUser()
  @ApiOperation({
    summary: 'Drill into ONE branch of the spend breakdown, by commit and teammate',
    description:
      'Takes a branchKey exactly as it appears in /spend/breakdown ("<owner/repo>#<branch>") ' +
      'and, over the SAME period window and the SAME internal-coding filter, returns one row ' +
      "per (commit, teammate) making that branch's spend. member is the teammate's " +
      'customerExternalId (their email); commitSha is null when no commit was recorded ' +
      '("No commit recorded"). The totals reconcile exactly with that branch\'s row in ' +
      '/spend/breakdown — same events, same math. spentUsd is null wherever there is no ' +
      'priced usage, never a made-up zero.',
  })
  @ApiResponse({ status: 200, description: 'Commit/teammate rows for the branch' })
  @ApiResponse({
    status: 403,
    description:
      'Publishable keys cannot read the drill (use a secret key), and the caller must ' +
      'be owner, admin, or finance.',
  })
  async getSpendBreakdownDrill(@Req() req: any, @Query() query: QuerySpendDrillDto) {
    return this.costControlService.getSpendBreakdownDrill(req.user.organizationId, query);
  }

  @Get('coverage')
  // Same short private cache as /spend: a fleet polling coverage doesn't need
  // sub-poll freshness, and the response carries asOf regardless.
  @Header('Cache-Control', 'private, max-age=30')
  // No OrgRoleGuard on purpose: the MCP fans caps + spend + coverage through one
  // Promise.all, so a role 403 here would kill all three for a developer-role key.
  // That same Promise.all is why this is allowlisted. No meter calls
  // coverage directly, but one 403 in the fan-out takes caps and spend down with it, and
  // denying an aggregate read to a key that can already read both buys no security.
  @IngestKeyAllowed()
  @ApiOperation({
    summary: 'Cap coverage per tool, over the trailing 7 days',
    description:
      'claudeCode and codex each report armed / notArmed / unknown / total as distinct teammates ' +
      'who used that tool in the window. A teammate counts as armed only when every machine seen ' +
      'using that tool had the cap running. unknown means it could not be determined: an older ' +
      'meter version, or a trust check that did not answer. Unknown is never counted as armed. ' +
      'The two tools count separately, so a teammate who uses both appears in both and the ' +
      "per-tool totals don't sum to total. The top-level armed and total count both tools " +
      'together. Read-only. Needs a secret key; a publishable ' +
      "key is refused. No role restriction, so a developer's on-device meter can read it. " +
      'asOf is null ' +
      'when there is no recent activity (honest absence, never a fabricated time). These are the ' +
      'same numbers the dashboard shows, from one shared coverage-math path.',
  })
  @ApiResponse({
    status: 200,
    description: 'Per-tool coverage counts for the window',
    type: CoverageResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Publishable keys cannot read coverage. Use a secret key.',
  })
  async getCoverage(@Req() req: any) {
    return this.costControlService.getCoverage(req.user.organizationId);
  }
}
