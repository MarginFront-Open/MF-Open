import { Injectable, ExecutionContext, UnauthorizedException, CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthService, PortalSessionUser } from '../../modules/auth/auth.service';

/**
 * Request with portal session user attached
 */
export interface PortalSessionRequest {
  portalUser: PortalSessionUser;
  user?: any;
}

/**
 * Guard that validates portal session tokens (prtl_*)
 *
 * Portal sessions are short-lived tokens created via the SDK that allow
 * customers to access their own billing data without exposing the
 * organization's API key.
 *
 * Use this for customer-facing portal endpoints:
 * - GET /portal/invoices
 * - GET /portal/subscriptions
 * - GET /portal/usage
 *
 * The guard extracts the customer context and attaches it to the request
 * as `request.portalUser`, which includes:
 * - customerId: The customer's ID
 * - organizationId: The org owning the customer
 * - sessionId: The portal session ID
 *
 * @example
 * @UseGuards(PortalSessionGuard)
 * @Get('portal/invoices')
 * getInvoices(@Req() req: PortalSessionRequest) {
 *   // req.portalUser.customerId is automatically set
 * }
 */
@Injectable()
export class PortalSessionGuard implements CanActivate {
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
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException(
        'Portal session token required. Provide a token via Authorization: Bearer prtl_* header.',
      );
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        'Invalid authorization format. Expected: Authorization: Bearer prtl_*',
      );
    }

    if (!token.startsWith('prtl_')) {
      throw new UnauthorizedException(
        'Invalid token type. Portal endpoints require a portal session token (prtl_*).',
      );
    }

    try {
      const portalUser = await this.authService.validatePortalSessionToken(token);

      if (!portalUser) {
        throw new UnauthorizedException(
          'Invalid or expired portal session. Please request a new portal session.',
        );
      }

      // Attach portal user to request for use in controllers
      request.portalUser = portalUser;

      // Also set a minimal user object for compatibility
      request.user = {
        id: portalUser.customerId,
        email: portalUser.customerEmail || '',
        name: portalUser.customerName || 'Customer',
        organizationId: portalUser.organizationId,
        isPortalSession: true,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid portal session');
    }
  }
}
