import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { resolveAlertRecipients } from '../../common/utils/billing-contact/alert-recipients';
import type { RevokedKeyFacts } from '../../common/exceptions/revoked-api-key.exception';

/**
 * WHAT THIS FILE DOES: emails an org's alert recipients that a key
 * they revoked is still being presented to the API. The Slack alert tells the
 * operator; this tells the key's owner, because the broken deployment is
 * theirs to fix and every rejected request is usage that
 * never lands on an invoice.
 *
 * WHO CALLS IT: CustomerFailureAlertService, which owns the Redis cooldown
 * (one email per org per hour, keyed on ORG so two broken deployments on two
 * IPs still produce one email). This service resolves recipients and sends.
 */
@Injectable()
export class RevokedKeyNoticeService {
  private readonly logger = new Logger(RevokedKeyNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Never throws: a notification failure must never change the 401 the caller
   * is about to send. Every skip path logs why.
   */
  async notify(facts: RevokedKeyFacts, attempts: number): Promise<void> {
    try {
      // One small query, at most once per org per cooldown window: the billing
      // fields resolveAlertRecipients needs. Deliberately NOT carried on
      // RevokedKeyFacts — the facts object travels through the exception and
      // alert context, and billing emails have no business riding along there.
      const org = await this.prisma.organizations.findUnique({
        where: { id: facts.organizationId },
        select: { billing_email: true, billingIdentity: true },
      });

      const recipients = await resolveAlertRecipients(this.prisma, facts.organizationId, org);
      if (recipients.length === 0) {
        this.logger.warn(
          `[RevokedKeyNoticeService] org ${facts.organizationId} has no billing contact ` +
            'and no current owner/finance members — revoked-key notice not sent.',
        );
        return;
      }

      for (const to of recipients) {
        // Returns null when Resend is unconfigured — a logged no-op, not an error.
        await this.emailService.sendRevokedKeyInUseEmail({
          to,
          keyLabel: facts.keyLabel,
          revokedAt: facts.revokedAt,
          attempts,
        });
      }
      this.logger.log(
        `[RevokedKeyNoticeService] revoked-key notice sent for org ${facts.organizationId} ` +
          `(key "${facts.keyLabel}", ${attempts} attempts, ${recipients.length} recipient(s)).`,
      );
    } catch (err) {
      this.logger.error(
        `[RevokedKeyNoticeService] failed sending the revoked-key notice for org ` +
          `${facts.organizationId}: ${(err as Error).message}. The 401 and the Slack ` +
          'alert are unaffected; only this email was lost.',
      );
    }
  }
}
