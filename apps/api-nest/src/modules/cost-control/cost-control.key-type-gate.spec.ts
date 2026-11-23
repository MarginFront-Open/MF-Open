/**
 * A publishable key gets 403 on every cost-control GET (caps, spend, spend/breakdown,
 * spend/breakdown/drill, coverage) through the global DENY-BY-DEFAULT, with no
 * per-route decorator, so the protection doesn't depend on anyone remembering one.
 *
 * Metadata is read off the REAL controller; behavior is driven through the REAL
 * PublishableKeyReadGuard. The completeness case is the forward lock: a sixth control
 * read added later cannot ship publishable-key-open without failing this file.
 */

import 'reflect-metadata';
import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  PublishableKeyReadGuard,
  PUBLISHABLE_KEY_ALLOWED_KEY,
} from '../../common/guards/publishable-key-read.guard';
import { PublishableKeyReadForbiddenException } from '../../common/exceptions/publishable-key-read-forbidden.exception';
import { CostControlController } from './cost-control.controller';

const ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const CONTROL_READS = [
  'listCaps',
  'getSpend',
  'getSpendBreakdown',
  'getSpendBreakdownDrill',
  'getCoverage',
] as const;

const handler = (name: string) =>
  (CostControlController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[
    name
  ];

function keyCtx(handlerName: string, keyType: 'publishable' | 'secret'): ExecutionContext {
  return {
    getHandler: () => handler(handlerName),
    getClass: () => CostControlController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          authMethod: 'api-key',
          keyType,
          organizationId: ORG_ID,
          apiKeyId: 'key_control_probe',
          role: 'developer',
        },
        method: 'GET',
        route: { path: `/v1/control/${handlerName}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

const guard = () => new PublishableKeyReadGuard(new Reflector());

describe('every cost-control read refuses a publishable key by DEFAULT', () => {
  it.each(CONTROL_READS)(
    '%s refuses a publishable key through the real guard, with no decorator on the route',
    (name) => {
      expect(() => guard().canActivate(keyCtx(name, 'publishable'))).toThrow(
        PublishableKeyReadForbiddenException,
      );
    },
  );

  it.each(CONTROL_READS)('%s still passes a secret key through the key-type gate', (name) => {
    expect(guard().canActivate(keyCtx(name, 'secret'))).toBe(true);
  });

  it('completeness: EVERY @Get handler on CostControlController denies a publishable key by default and none carries @PublishableKeyAllowed, so a new control read cannot ship publishable-key-open', () => {
    const proto = CostControlController.prototype as unknown as Record<string, unknown>;
    const getHandlers = Object.getOwnPropertyNames(proto).filter((name) => {
      if (name === 'constructor') return false;
      const fn = proto[name];
      return (
        typeof fn === 'function' && Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.GET
      );
    });
    expect(getHandlers.sort()).toEqual([...CONTROL_READS].sort());
    for (const name of getHandlers) {
      expect(
        Reflect.getMetadata(PUBLISHABLE_KEY_ALLOWED_KEY, proto[name] as object),
      ).toBeUndefined();
      expect(() => guard().canActivate(keyCtx(name, 'publishable'))).toThrow(
        PublishableKeyReadForbiddenException,
      );
    }
  });
});
