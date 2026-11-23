import { OrganizationRequiredException } from '../../common/exceptions/organization-required.exception';

// Shared by BOTH ingest doors (canonical /v1/usage/record and the
// /v1/sdk/usage/record alias) so their auth-method rejection cannot drift apart.
export function requireIngestOrganizationId(req: any): string {
  const organizationId = req?.user?.organizationId;
  if (!organizationId) {
    throw new OrganizationRequiredException();
  }
  return organizationId;
}
