import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentProviderDto } from './create-payment-provider.dto';

async function typeErrors(type: string): Promise<string[]> {
  const dto = plainToInstance(CreatePaymentProviderDto, { type });
  const errors = await validate(dto);
  return errors
    .filter((error) => error.property === 'type')
    .flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('CreatePaymentProviderDto.type', () => {
  it('accepts stripe', async () => {
    await expect(typeErrors('stripe')).resolves.toEqual([]);
  });

  it('rejects any other provider and names Stripe as the one supported', async () => {
    const messages = await typeErrors('square');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/type must be "stripe"/);
  });
});
