/**
 * Basic Usage Example
 *
 * Demonstrates how to initialize the MarginFront client and verify your API key.
 *
 * Run with: npx ts-node examples/basic-usage.ts
 */

import { MarginFrontClient, MarginFrontError, AuthenticationError } from '../src';

async function main() {
  // Point the client at your own MarginFront server. There is no built-in
  // server: leave baseUrl out only if MARGINFRONT_API_URL is set instead.
  const client = new MarginFrontClient({
    apiKey: 'mf_sk_your_secret_key',
    baseUrl: 'http://localhost:4000/v1',
    timeout: 30000,
    debug: true, // Enable request/response logging
  });

  try {
    // Verify the connection and get organization details
    const result = await client.verify();

    console.log('Connection verified!');
    console.log(`Organization: ${result.organization.name}`);
    console.log(`Organization ID: ${result.organization.id}`);
    console.log(`Verified: ${result.verified}`);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      console.error('Authentication failed - check your API key');
    } else if (error instanceof MarginFrontError) {
      console.error(`API Error: ${error.message} (${error.statusCode})`);
    } else {
      throw error;
    }
  }
}

main();
