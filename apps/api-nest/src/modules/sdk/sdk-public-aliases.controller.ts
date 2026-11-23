import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  UsePipes,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { SdkService } from './sdk.service';
import { RecordUsageDto } from './dto/record-usage.dto';
import { ingestValidationPipe } from './ingest-validation.pipe';
import { requireIngestOrganizationId } from './require-ingest-organization-id';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
// Marks the usage-record POST as the INGEST path, so any role guard that runs on it
// short-circuits to allow before it reads a key's role. A corrupt or unrecognized
// permissions blob can never block ingestion.
import { IngestRoute } from '../../common/guards/org-role.guard';
import { PublishableKeyAllowed } from '../../common/guards/publishable-key-read.guard';
import { IngestKeyAllowed } from '../../common/guards/ingest-key-scope.guard';
import type { KeyRole } from '@marginfront/db';

// The CANONICAL short paths (/v1/verify, /v1/usage/record). The /v1/sdk/*
// equivalents on SdkController are the alias. Both doors must behave
// identically.
//
// The @SkipThrottle({ default, public }) here MIRRORS SdkController for the same
// reason: all three buckets apply to every request, so @Throttle({ sdk })
// alone would still leave the default 1200/60s and public 60/60s buckets capping
// ingest. Skip BOTH so only the sdk 60K/60s bucket governs — keeping these
// canonical paths exactly as loose as the /v1/sdk/* paths.
@ApiTags('SDK')
@Controller()
@UseGuards(CombinedAuthGuard)
@ApiSecurity('api-key')
@SkipThrottle({ default: true, public: true })
@Throttle({ sdk: { limit: 60000, ttl: 60_000 } })
export class SdkPublicAliasesController {
  constructor(private readonly sdkService: SdkService) {}

  // @PublishableKeyAllowed on verify + me/key (the key-identity contract): the code-cost-clarity
  // installer calls GET /v1/verify then GET /v1/me/key at init and depends on a 200 +
  // {role, keyType} for a publishable key to print its "that is the publishable key,
  // paste the secret one" message; @marginfront/sdk connect()/verify() uses /verify too.
  // These two expose only org id+name and role/keyType — safe for an embeddable key.
  // The same holds for the ingest-role allowance. connect()/verify() is the first call the cost
  // meter and the SDK make, so a role deny here fails the install before any usage is ever sent.
  @Get('verify')
  @PublishableKeyAllowed()
  @IngestKeyAllowed()
  @ApiOperation({
    summary: 'Verify API key',
    description: 'Verify the API key and return organization information',
  })
  @ApiResponse({ status: 200, description: 'API key verified successfully' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  @ApiResponse({
    status: 503,
    description: 'MarginFront could not check the API key. Retry after the Retry-After interval.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many failed API key attempts from this network. Retry after the Retry-After interval.',
  })
  async verifyApiKey(@Req() req: any) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    const result = await this.sdkService.verifyApiKey(organizationId);
    return result;
  }

  // Deliberately carries no OrgRoleGuard/role decorator, so it stays reachable by
  // every key role including the 'ingest' floor — an SDK/MCP client can always ask "what can
  // I do" before a call that might 403.
  // Dropping it from the ingest allowlist is the costliest mistake: the cost meter's auth-hold
  // recovery probes this every 5 minutes to decide whether held usage can flush, so a
  // 403 wedges the hold permanently and parks the customer's usage on disk with no alarm.
  @Get('me/key')
  @PublishableKeyAllowed()
  @IngestKeyAllowed()
  @ApiOperation({
    summary: 'Identify this key',
    description:
      "Return the calling API key's dashboard role and key type. Works for every key role, " +
      'including ingest-only keys.',
  })
  @ApiResponse({
    status: 200,
    description: 'Key identity',
    schema: {
      type: 'object',
      properties: {
        role: { type: 'string', example: 'developer' },
        keyType: { type: 'string', example: 'secret' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({
    status: 503,
    description: 'MarginFront could not check the API key. Retry after the Retry-After interval.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many failed API key attempts from this network. Retry after the Retry-After interval.',
  })
  whoami(@Req() req: any): { role: KeyRole | null; keyType: 'secret' | 'publishable' | null } {
    return {
      role: req.user?.role ?? null,
      keyType: req.user?.keyType ?? null,
    };
  }

  @Post('usage/record')
  @IngestRoute()
  @HttpCode(HttpStatus.OK)
  @UsePipes(ingestValidationPipe)
  @ApiOperation({
    summary: 'Record usage events',
    description: 'Record usage events for customers. Accepts batch of 1-100 records.',
  })
  @ApiResponse({ status: 200, description: 'Usage records processed' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key, or a login token was sent instead of an API key.',
  })
  @ApiResponse({
    status: 503,
    description: 'MarginFront could not check the API key. Retry after the Retry-After interval.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many failed API key attempts from this network. Retry after the Retry-After interval.',
  })
  async recordUsage(@Req() req: any, @Body() recordUsageDto: RecordUsageDto) {
    const organizationId = requireIngestOrganizationId(req);
    const result = await this.sdkService.recordUsage(organizationId, recordUsageDto);
    return result;
  }
}
