/**
 * Rejecting an invalid subscription enum value must LIST the
 * allowed values, so a caller who typed "cancelled" (UK spelling) can read the
 * 400 and self-correct to "canceled".
 *
 * These fields use @IsIn, not @IsEnum(<inline array>). @IsEnum on an array
 * validates fine but renders an EMPTY allowed-values list ("status must be one
 * of the following values: "), because class-validator's validEnumValues()
 * drops numeric keys (a TS numeric-enum reverse-mapping workaround) and array
 * keys are ALL numeric. @IsIn lists the values in its message.
 *
 * The PATCH case runs over real HTTP through the same ValidationPipe options
 * main.ts uses; the other enum fields are checked at the validator level.
 */
import { Body, Controller, INestApplication, Patch, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateSubscriptionDto } from './update-subscription.dto';
import { CreateSubscriptionDto } from './create-subscription.dto';
import { QuerySubscriptionDto } from './query-subscription.dto';
import { QueryChangelogDto } from './query-changelog.dto';

const UPDATE_STATUS_VALUES = ['active', 'pending', 'upcoming', 'expired', 'canceled', 'ended'];

@Controller('subscriptions-probe')
class SubscriptionProbeController {
  @Patch(':id')
  update(@Body() _dto: UpdateSubscriptionDto) {
    return { ok: true };
  }
}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [SubscriptionProbeController],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  // Identical options to the global pipe in main.ts.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('PATCH with an invalid subscription status', () => {
  it('400s with a message listing every allowed status value', async () => {
    const response = await fetch(`${baseUrl}/v1/subscriptions-probe/sub-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled', changeReason: 'spelling probe' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    const statusError = [body.message].flat().find((m: string) => m.includes('status'));
    expect(statusError).toBeDefined();
    for (const allowed of UPDATE_STATUS_VALUES) {
      expect(statusError).toContain(allowed);
    }
  });

  it('still accepts a valid status', async () => {
    const response = await fetch(`${baseUrl}/v1/subscriptions-probe/sub-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', changeReason: 'valid probe' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('every subscription DTO enum field lists its allowed values on rejection', () => {
  it.each([
    [UpdateSubscriptionDto, 'status', UPDATE_STATUS_VALUES],
    [UpdateSubscriptionDto, 'billingCycle', ['monthly', 'yearly', 'custom']],
    [UpdateSubscriptionDto, 'billingModel', ['subscription', 'usage', 'hybrid']],
    [CreateSubscriptionDto, 'status', ['upcoming', 'active', 'ended']],
    [CreateSubscriptionDto, 'billingCycle', ['monthly', 'yearly', 'custom']],
    [CreateSubscriptionDto, 'billingModel', ['subscription', 'usage', 'hybrid']],
    [QuerySubscriptionDto, 'status', ['upcoming', 'active', 'ended']],
    [QuerySubscriptionDto, 'billingCycle', ['monthly', 'yearly', 'custom']],
    [QuerySubscriptionDto, 'billingModel', ['subscription', 'usage', 'hybrid']],
    [QuerySubscriptionDto, 'sortOrder', ['asc', 'desc']],
    [
      QueryChangelogDto,
      'changeType',
      ['created', 'updated', 'status_change', 'plan_change', 'renewal'],
    ],
    [QueryChangelogDto, 'sortOrder', ['asc', 'desc']],
  ] as Array<[new () => object, string, string[]]>)(
    '%p.%s rejection message names every allowed value',
    async (dtoClass, field, allowedValues) => {
      const instance = plainToInstance(dtoClass, { [field]: 'not-a-real-value' });
      const errors = await validate(instance);
      const fieldError = errors.find((e) => e.property === field);
      expect(fieldError).toBeDefined();
      const message = Object.values(fieldError!.constraints ?? {}).join('; ');
      for (const allowed of allowedValues) {
        expect(message).toContain(allowed);
      }
    },
  );
});
