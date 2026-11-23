import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthService } from '../../modules/auth/auth.service';

/**
 * Guard that only allows requests authenticated with a SECRET API key (mf_sk_*)
 *
 * Use this for sensitive operations that should only be performed server-side:
 * - Creating portal sessions
 * - Managing customers
 * - Tracking usage events
 * - Accessing full invoice details
 *
 * @example
 * @UseGuards(SecretKeyGuard)
 * @Post('portal-sessions')
 * createPortalSession() { ... }
 */
@Injectable()
export class SecretKeyGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check for @Public() decorator
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
        'API key required. Provide a secret key (mf_sk_*) via x-api-key header.',
      );
    }

    try {
      // This will throw if key is not a secret key
      const user = await this.authService.validateSecretKey(apiKey);
      request.user = user;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid API key');
    }
  }
}
