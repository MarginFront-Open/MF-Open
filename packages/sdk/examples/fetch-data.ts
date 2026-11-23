/**
 * Fetch Data Example
 *
 * Demonstrates how to retrieve customers, invoices, analytics, and subscriptions.
 *
 * Run with: npx ts-node examples/fetch-data.ts
 */

import { MarginFrontClient, NotFoundError } from '../src';

async function main() {
  const client = new MarginFrontClient({
    apiKey: 'mf_sk_your_secret_key',
    baseUrl: 'http://localhost:4000/v1',
  });

  // ==================== CUSTOMERS ====================
  console.log('=== CUSTOMERS ===\n');

  // Create a customer
  console.log('Creating customer...');
  const newCustomer = await client.customers.create({
    name: 'Acme Corporation',
    externalId: 'acme_corp_123',
    email: 'billing@acme.example',
    phone: '+1-555-0123',
    timezone: 'America/New_York',
    billingContactName: 'John Doe',
    billingContactEmail: 'john.doe@acme.example',
    netTerms: 30,
    invoiceEmailRecipients: ['billing@acme.example', 'john.doe@acme.example'],
    metadata: {
      industry: 'Technology',
      tier: 'enterprise',
    },
  });
  console.log(`Created customer: ${newCustomer.name} (${newCustomer.id})`);

  // List all customers
  console.log('\nListing all customers...');
  const customers = await client.customers.list();
  console.log(`Found ${customers.length} customers:`);
  customers.forEach((customer) => {
    console.log(`  - ${customer.name} (${customer.externalId || customer.id})`);
  });

  // Get a specific customer
  console.log(`\nFetching customer ${newCustomer.id}...`);
  const customer = await client.customers.get(newCustomer.id);
  console.log(`Customer details:`);
  console.log(`  Name: ${customer.name}`);
  console.log(`  Email: ${customer.email}`);
  console.log(`  Status: ${customer.status}`);
  console.log(`  Subscriptions: ${customer.subscriptions?.length || 0}`);

  // Update customer
  console.log('\nUpdating customer...');
  const updatedCustomer = await client.customers.update(newCustomer.id, {
    metadata: { ...newCustomer.metadata, updated: true },
  });
  console.log(`Updated customer: ${updatedCustomer.name}`);

  // ==================== INVOICES ====================
  console.log('\n=== INVOICES ===\n');

  // List invoices
  console.log('Listing invoices...');
  const { invoices, totalResults } = await client.invoices.list({
    status: 'pending',
    page: 1,
    limit: 10,
  });
  console.log(`Found ${totalResults} pending invoices (showing ${invoices.length}):`);
  invoices.forEach((invoice) => {
    console.log(`  - ${invoice.invoiceNumber}: $${invoice.totalAmount} (${invoice.status})`);
  });

  // Get a specific invoice
  if (invoices.length > 0) {
    console.log(`\nFetching invoice ${invoices[0].id}...`);
    const invoice = await client.invoices.get(invoices[0].id);
    console.log(`Invoice details:`);
    console.log(`  Number: ${invoice.invoiceNumber}`);
    console.log(`  Customer: ${invoice.customer.name}`);
    console.log(`  Total: $${invoice.totalAmount}`);
    console.log(`  Due: ${invoice.dueDate}`);
    console.log(`  Line items: ${invoice.lineItems.length}`);
  }

  // ==================== ANALYTICS ====================
  console.log('\n=== ANALYTICS ===\n');

  // Get usage analytics
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 1);
  const endDate = new Date();

  console.log('Fetching usage analytics...');
  const analytics = await client.analytics.usage({
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    groupBy: 'daily',
  });

  console.log('Analytics summary:');
  console.log(`  Total events: ${analytics.summary.totalEvents}`);
  console.log(`  Total quantity: ${analytics.summary.totalQuantity}`);
  console.log(`  Total cost: $${analytics.summary.totalCost}`);
  console.log(`  Unique customers: ${analytics.summary.uniqueCustomers}`);
  console.log(`  Unique agents: ${analytics.summary.uniqueAgents}`);

  console.log(`\nDaily breakdown (last 5 days):`);
  analytics.data.slice(-5).forEach((point) => {
    console.log(`  ${point.date}: ${point.quantity} units, $${point.cost}`);
  });

  // ==================== SUBSCRIPTIONS ====================
  console.log('\n=== SUBSCRIPTIONS ===\n');

  // List subscriptions
  console.log('Listing active subscriptions...');
  const { subscriptions, totalResults: subTotal } = await client.subscriptions.list({
    status: 'active',
    page: 1,
    limit: 10,
  });
  console.log(`Found ${subTotal} active subscriptions (showing ${subscriptions.length}):`);
  subscriptions.forEach((sub) => {
    console.log(`  - ${sub.customer.name}: ${sub.plan.name} (${sub.status})`);
  });

  // Get a specific subscription with usage
  if (subscriptions.length > 0) {
    console.log(`\nFetching subscription ${subscriptions[0].id}...`);
    const sub = await client.subscriptions.get(subscriptions[0].id);
    console.log(`Subscription details:`);
    console.log(`  Customer: ${sub.customer.name}`);
    console.log(`  Agent: ${sub.agent.name}`);
    console.log(`  Plan: ${sub.plan.name}`);
    console.log(`  Status: ${sub.status}`);
    console.log(`  Billing cycle: ${sub.billingCycle}`);
    console.log(`  Current period usage:`);
    console.log(`    - Events: ${sub.usage.totalEvents}`);
    console.log(`    - Quantity: ${sub.usage.totalQuantity}`);
    console.log(`    - Period: ${sub.usage.periodStart} to ${sub.usage.periodEnd}`);
  }

}

main().catch(console.error);
