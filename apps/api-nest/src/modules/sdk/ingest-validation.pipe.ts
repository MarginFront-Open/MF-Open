import { ValidationPipe } from '@nestjs/common';

// Strict unknown-field policy, scoped to the two
// usage-record doors only. The global pipe in main.ts stays whitelist:false —
// other routes (webhooks especially) must keep tolerating fields their DTOs
// don't declare. Method-scoped pipes run AFTER the global pipe, so this adds
// strictness on top without changing anything else.
export const ingestValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
});
