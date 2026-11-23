import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';

describe('Organizations logo URL validation', () => {
  describe('CreateOrganizationDto / UpdateOrganizationDto', () => {
    it.each([
      'http://cdn.example.com/logo.png',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
    ])('rejects non-HTTPS logo URL %s on CreateOrganizationDto', async (logo) => {
      const dto = plainToInstance(CreateOrganizationDto, { name: 'Acme Corp', logo });
      const errors = await validate(dto);
      const logoError = errors.find((e) => e.property === 'logo');
      expect(logoError).toBeDefined();
      expect(Object.values(logoError?.constraints ?? {}).join(' ')).toContain(
        'public https:// address',
      );
    });

    it('rejects non-HTTPS logo URL on UpdateOrganizationDto', async () => {
      const dto = plainToInstance(UpdateOrganizationDto, {
        logo: 'http://cdn.example.com/logo.png',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'logo')).toBe(true);
    });

    it('accepts valid HTTPS logo URL and empty string on CreateOrganizationDto', async () => {
      const validDto = plainToInstance(CreateOrganizationDto, {
        name: 'Acme Corp',
        logo: 'https://cdn.example.com/logo.png',
      });
      expect(await validate(validDto)).toHaveLength(0);

      const emptyDto = plainToInstance(CreateOrganizationDto, {
        name: 'Acme Corp',
        logo: '',
      });
      expect(await validate(emptyDto)).toHaveLength(0);
    });
  });

  describe('OrganizationsService createOrganization / updateOrganization', () => {
    const makeService = () => {
      const prisma = {
        users: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        user_organizations: { findFirst: jest.fn().mockResolvedValue(null) },
        ba_member: { findFirst: jest.fn().mockResolvedValue({ role: 'owner' }) },
        organizations: { update: jest.fn().mockResolvedValue({ id: 'org-1' }) },
        $transaction: jest.fn(),
      };
      return { service: new OrganizationsService(prisma as any), prisma };
    };

    it.each([
      'http://cdn.example.com/logo.png',
      'https://127.0.0.1/logo.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/logo.png',
      'https://printer.local/logo.png',
      'https://metadata.google.internal/logo.png',
      'https://[::1]/logo.png',
      'https://[::ffff:127.0.0.1]/logo.png',
      'https://user:pass@cdn.example.com/logo.png',
      'data:image/png;base64,AAAA',
    ])('createOrganization throws BadRequestException for unsafe logo %s', async (logo) => {
      const { service, prisma } = makeService();
      await expect(
        service.createOrganization('user-1', { name: 'Acme Corp', logo } as any),
      ).rejects.toThrow(/Logo URL was rejected because it must be a public https:\/\/ address/);
      await expect(
        service.createOrganization('user-1', { name: 'Acme Corp', logo } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      'http://cdn.example.com/logo.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/logo.png',
      'https://[::ffff:10.0.0.1]/logo.png',
    ])('updateOrganization throws BadRequestException for unsafe logo %s', async (logo) => {
      const { service, prisma } = makeService();
      await expect(service.updateOrganization('user-1', 'org-1', { logo } as any)).rejects.toThrow(
        /Logo URL was rejected because it must be a public https:\/\/ address/,
      );
      await expect(
        service.updateOrganization('user-1', 'org-1', { logo } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organizations.update).not.toHaveBeenCalled();
    });

    it('updateOrganization allows empty string or valid public HTTPS logo', async () => {
      const { service, prisma } = makeService();
      await expect(
        service.updateOrganization('user-1', 'org-1', {
          logo: 'https://cdn.example.com/logo.png',
        } as any),
      ).resolves.toMatchObject({ organization: { id: 'org-1' } });
      expect(prisma.organizations.update).toHaveBeenCalledTimes(1);

      prisma.organizations.update.mockClear();
      await expect(
        service.updateOrganization('user-1', 'org-1', { logo: '' } as any),
      ).resolves.toMatchObject({ organization: { id: 'org-1' } });
      expect(prisma.organizations.update).toHaveBeenCalledTimes(1);
    });
  });
});
