import { Injectable, ExecutionContext, UnauthorizedException, CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface BetterAuthPayload {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

@Injectable()
export class BetterAuthGuard implements CanActivate {
  private jwks: jose.JWTVerifyResult<BetterAuthPayload> | null = null;
  private jwksLastFetched: number = 0;
  private readonly JWKS_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('No authorization header');
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization header format');
    }

    try {
      const user = await this.validateJwt(token);
      request.user = user;
      return true;
    } catch (error) {
      console.error('[BetterAuthGuard] JWT validation failed:', error);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private async validateJwt(token: string): Promise<AuthenticatedUser> {
    const betterAuthUrl = this.configService.get<string>('BETTER_AUTH_URL');

    if (!betterAuthUrl) {
      throw new Error('BETTER_AUTH_URL not configured');
    }

    const JWKS = jose.createRemoteJWKSet(new URL(`${betterAuthUrl}/api/auth/jwks`));

    try {
      const { payload } = await jose.jwtVerify(token, JWKS, {
        issuer: betterAuthUrl,
        audience: betterAuthUrl,
      });

      const typedPayload = payload as unknown as BetterAuthPayload;

      return {
        id: typedPayload.id,
        email: typedPayload.email,
        name: typedPayload.name,
        emailVerified: typedPayload.emailVerified,
      };
    } catch (error) {
      if (error instanceof jose.errors.JWTExpired) {
        throw new UnauthorizedException('Token expired');
      }
      if (error instanceof jose.errors.JWTClaimValidationFailed) {
        throw new UnauthorizedException('Token validation failed');
      }
      throw error;
    }
  }
}
