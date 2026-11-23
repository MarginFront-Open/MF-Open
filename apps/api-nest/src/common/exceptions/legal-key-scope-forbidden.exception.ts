import { ForbiddenException } from '@nestjs/common';

/**
 * The 403 a legal-role API key gets on any authenticated route outside the Law surface
 *The allowed surface is: routes whose @OrgRoles list includes 'legal', plus
 * exactly what an ingest key can reach (usage POSTs + the identity/ops doors).
 *
 * Extends ForbiddenException DIRECTLY, mirroring IngestKeyScopeForbiddenException:
 * CustomerFailureAlertFilter pages only on its own named classes, so a plain subclass
 * keeps classifyCustomerFailure at null and this denial wakes nobody. Observability is
 * the guard's log line instead.
 *
 * REUSES the `insufficient_key_role` code deliberately: the MCP branches on that exact
 * code to render this denial's own message, while its generic 403 branch blames a
 * publishable key (mf_pk_*) instead — a wrong root cause that would send a customer to
 * rotate a key that was never the problem. The plain object passed to super() becomes
 * the response body verbatim.
 *
 * `required_roles` is EMPTY on purpose, same contract as the ingest exception: the roles
 * that clear THIS guard are not the roles the target route wants (its own OrgRoleGuard is
 * usually narrower), so a rendered "Allowed roles" list would send the customer to mint a
 * key that 403s again. An empty list makes both clients fall through to the message
 * sentence, which carries the remedy.
 */
export class LegalKeyScopeForbiddenException extends ForbiddenException {
  constructor(keyRole: string) {
    super({
      statusCode: 403,
      code: 'insufficient_key_role',
      required_roles: [],
      key_role: keyRole,
      message:
        `This API key's role is '${keyRole}'. A legal key can manage matters and their ` +
        'routing rules, assign usage events to matters, pull the matter audit export, ' +
        'send usage records, check which organization it belongs to, and read your ' +
        "spend controls. It can't reach anything else here, including customers, " +
        'invoices, revenue, and payouts. For this request, use a key with a higher ' +
        'role. Create one in the MarginFront dashboard under Build, then API keys.',
    });
  }
}
