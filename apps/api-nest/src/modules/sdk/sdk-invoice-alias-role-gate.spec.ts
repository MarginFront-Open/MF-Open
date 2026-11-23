/**
 * Role-gate tests for the SDK invoice alias.
 *
 * /v1/sdk/invoices/generate and /:invoiceId/send are aliases of the canonical
 * /v1/invoices/generate + /:invoiceId/send so SDK traffic lands in the SDK throttler bucket.
 * The canonical routes are MANAGE_MONEY_ROLES-gated and the aliases mirror that gate exactly,
 * so no key of a lower role can generate or send an invoice through them. This locks the
 * specific role set + the @OrgFromUser scoping (the route
 * is param-less, so the org must come from the authenticated principal).
 */

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { SdkController } from './sdk.controller';

const proto = SdkController.prototype as any;

function guardNames(handler: any): string[] {
  const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  return guards.map((g) => g?.name ?? String(g));
}

describe('SdkController legacy invoice alias role gate', () => {
  it.each(['generateInvoice', 'sendInvoice'])(
    '%s carries OrgRoleGuard + MANAGE_MONEY_ROLES + @OrgFromUser',
    (name) => {
      const handler = proto[name];
      expect(guardNames(handler)).toContain('OrgRoleGuard');
      expect(Reflect.getMetadata('orgRoles', handler)).toEqual([...MANAGE_MONEY_ROLES]);
      expect(Reflect.getMetadata('orgFromUser', handler)).toBe(true);
    },
  );

  it('the pure ingest route (usage/record) is NOT money-gated — ingest stays sacred', () => {
    expect(Reflect.getMetadata('orgRoles', proto.recordUsage)).not.toEqual([...MANAGE_MONEY_ROLES]);
    expect(Reflect.getMetadata('ingestRoute', proto.recordUsage)).toBe(true);
  });
});
