jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'node:dns/promises';
import { isPublicAddress, isPublicHostname } from './public-host';

const mockedLookup = lookup as unknown as jest.Mock;

describe('isPublicAddress', () => {
  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5'])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('isPublicHostname', () => {
  beforeEach(() => mockedLookup.mockReset());

  it.each(['localhost', 'api.localhost', '127.0.0.1', '10.1.2.3', '[::1]', ''])(
    'refuses %s without a DNS lookup',
    async (hostname) => {
      await expect(isPublicHostname(hostname)).resolves.toBe(false);
      expect(mockedLookup).not.toHaveBeenCalled();
    },
  );

  it('refuses a name that resolves to a private address', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.0.10', family: 4 }]);
    await expect(isPublicHostname('intranet.example.com')).resolves.toBe(false);
  });

  it('refuses a name when any of its addresses is private', async () => {
    mockedLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(isPublicHostname('mixed.example.com')).resolves.toBe(false);
  });

  it('refuses a name that does not resolve', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(isPublicHostname('nowhere.example.com')).resolves.toBe(false);
  });

  it('accepts a name that resolves only to public addresses', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(isPublicHostname('example.com')).resolves.toBe(true);
  });
});
