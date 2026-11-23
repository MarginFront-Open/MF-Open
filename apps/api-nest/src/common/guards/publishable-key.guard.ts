import { Injectable, ExecutionContext, UnauthorizedException, CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthService } from '../../modules/auth/auth.service';

/**
 * Guard that allows requests authenticated with either:
 * - Publishable API key (mf_pk_*) - safe for frontend use
 * - Secret API key (mf_sk_*) - higher privilege, also works
 *
 * Mounted on zero routes. A route-scoped mount is
 * dead code for its stated purpose: the global PublishableKeyReadGuard denies a
 * publishable key on every authenticated route before any route-scoped guard runs,
 * unless the route carries @PublishableKeyAllowed. Kept only because the revoked-401
 * spec constructs it directly; do not mount it expecting a publishable-readable route.
 */
@Injectable()
export class PublishableKeyGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private authService: AuthService,
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
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      throw new UnauthorizedException(
        'API key required. Provide a publishable key (mf_pk_*) or secret key (mf_sk_*) via x-api-key header.',
      );
    }

    try {
      // Accepts both publishable and secret keys
      const user = await this.authService.validatePublishableKey(apiKey);
      request.user = user;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid API key');
    }
  }
}
