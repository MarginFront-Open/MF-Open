import { isPublicIpAddress, isSafePublicHttpsUrl } from '../public-https-url'

describe('public-https-url', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:169.254.169.254',
  ])('isPublicIpAddress rejects %s', (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false)
  })

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::6810:84e5'])(
    'isPublicIpAddress accepts %s',
    (ip) => {
      expect(isPublicIpAddress(ip)).toBe(true)
    }
  )

  it.each([
    '',
    'not-a-url',
    'http://cdn.example.com/logo.png',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'https://user:pass@cdn.example.com/logo.png',
    'https://localhost/logo.png',
    'https://sub.localhost./logo.png',
    'https://printer.local/logo.png',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.1/logo.png',
    'https://[::1]/logo.png',
    'https://[::ffff:127.0.0.1]/logo.png',
  ])('isSafePublicHttpsUrl rejects %s', (url) => {
    expect(isSafePublicHttpsUrl(url)).toBe(false)
  })

  it.each([
    'https://cdn.example.com/logo.png',
    'https://www.google.com/s2/favicons?domain=example.com&sz=128',
    'https://93.184.216.34/logo.png',
    'https://[2606:4700::6810:84e5]/logo.png',
  ])('isSafePublicHttpsUrl accepts %s', (url) => {
    expect(isSafePublicHttpsUrl(url)).toBe(true)
  })
})
