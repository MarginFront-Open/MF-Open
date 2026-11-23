import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto, QueryApiKeyDto } from './dto';
// The mint/revoke routes gate on MINT_KEY_ROLES, which is
// MANAGE_BUILD_ROLES PLUS finance — finance may reach the mint door to create a
// finance-scoped key. WHICH role a mint may stamp is then capped per-minter by the
// service (mintableKeyRoles), so this wider door does not let finance mint build keys.
import { OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';
import { MINT_KEY_ROLES, PRIV_READ_KEYS } from '@marginfront/db';

@ApiTags('api-keys')
@Controller('org/:orgId/developer/api-keys')
@ApiBearerAuth()
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  /**
   * Create a key pair (secret + publishable). The recommended way to mint keys.
   */
  @Post('pair')
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MINT_KEY_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a key pair (secret + publishable)',
    description:
      'Creates both a secret key (for server-side use) and a publishable key (safe for frontend). This is the recommended approach.',
  })
  @ApiResponse({
    status: 201,
    description: 'Key pair created successfully',
    schema: {
      example: {
        secretKey: {
          id: 'uuid',
          name: 'My Keys (Secret)',
          key: 'mf_sk_xxxx', // Returned only in this response
          keyType: 'secret',
        },
        publishableKey: {
          id: 'uuid',
          name: 'My Keys (Publishable)',
          key: 'mf_pk_xxxx', // Safe to expose
          keyType: 'publishable',
        },
        message: 'Secret key will only be displayed once...',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async createApiKeyPair(
    @Param('orgId') orgId: string,
    @Request() req: any,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.apiKeysService.createApiKeyPair(orgId, req.user, dto);
  }

  @Get()
  @UseGuards(OrgRoleGuard)
  // A MEMBER does not read the key list, because the list exposes key
  // material; developer reads it (Manage-BUILD already covers enumerating
  // your own org's keys).
  @OrgRoles(...PRIV_READ_KEYS)
  @ApiOperation({ summary: 'Get all API keys for the organization' })
  @ApiResponse({ status: 200, description: 'API keys retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getApiKeys(@Param('orgId') orgId: string, @Query() query: QueryApiKeyDto) {
    return this.apiKeysService.getApiKeys(orgId, query);
  }

  /**
   * Get publishable keys only (safe to expose to frontend)
   */
  @Get('publishable')
  @UseGuards(OrgRoleGuard)
  // Same role gate as GET / above — see the comment there.
  @OrgRoles(...PRIV_READ_KEYS)
  @ApiOperation({
    summary: 'Get publishable keys (safe for frontend)',
    description: 'Returns only publishable keys which are safe to use in frontend code.',
  })
  @ApiResponse({
    status: 200,
    description: 'Publishable keys retrieved successfully',
    schema: {
      example: [
        {
          id: 'uuid',
          name: 'My Keys (Publishable)',
          key: 'mf_pk_xxxx',
          keyType: 'publishable',
        },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getPublishableKeys(@Param('orgId') orgId: string) {
    return this.apiKeysService.getPublishableKeys(orgId);
  }

  // Revoke is deliberately open to API keys, unlike the mint routes above: revoke writes
  // no createdById, and gating it has its own blast radius (a secret-key revoke also ends
  // every live portal magic link and session).
  @Put(':keyId/revoke')
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MINT_KEY_ROLES)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 200, description: 'API key revoked successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async revokeApiKey(@Param('orgId') orgId: string, @Param('keyId') keyId: string) {
    return this.apiKeysService.revokeApiKey(keyId, orgId);
  }
}
