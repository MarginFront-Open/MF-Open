import { ForbiddenException } from '@nestjs/common';

/**
 * The 403 an EXPLICIT ingest-role API key gets on any authenticated route outside the
 * eight-handler ingest allowlist.
 *
 * Extends ForbiddenException DIRECTLY, mirroring PublishableKeyReadForbiddenException:
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
 * `required_roles` is EMPTY on purpose, and that is the whole remedy contract. Every role
 * above the ingest floor clears THIS guard, but the route's own OrgRoleGuard is usually
 * narrower (a money read wants owner/admin/finance), so a five-role list rendered by a
 * client as "Allowed roles" would send a customer to mint a member key that 403s again on
 * the retry. Both clients read an empty list as "no machine-readable role list, use the
 * server's sentence": the MCP falls through to `message` verbatim
 * (packages/mcp/src/index.ts errorResponse), and the SDK's only consumer of the field is
 * usage.record's 403 warning, which this guard can never produce because both
 * usage-record POSTs carry @IngestRoute and are allowlisted.
 */
export class IngestKeyScopeForbiddenException extends ForbiddenException {
  constructor(keyRole: string) {
    super({
      statusCode: 403,
      code: 'insufficient_key_role',
      required_roles: [],
      key_role: keyRole,
      message:
        `This API key's role is '${keyRole}'. An ingest key can send usage records, ` +
        'check which organization it belongs to, and read your spend controls: the caps, ' +
        "your organization's AI spend for the current period, any named teammate's spend, " +
        "and cap coverage. It can't reach anything else here, including customers, " +
        'invoices, revenue, and payouts. For this request, use a key with a higher role. ' +
        'Create one in the MarginFront dashboard under Build, then API keys.',
    });
  }
}
