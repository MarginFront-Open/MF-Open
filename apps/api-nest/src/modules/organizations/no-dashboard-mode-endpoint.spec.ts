import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The API has no dashboard-mode endpoint: the dashboard writes the mode
 * through a Prisma-backed Server Action (app/actions/set-dashboard-mode.ts in
 * the dashboard app), so a controller route, service method or DTO here would
 * have no caller. Source assertion (not an e2e request) because an unused
 * route is the kind of addition a passing test suite won't otherwise catch.
 */
describe('organizations API has no dashboard-mode endpoint', () => {
  const controllerSrc = readFileSync(join(__dirname, 'organizations.controller.ts'), 'utf8');
  const serviceSrc = readFileSync(join(__dirname, 'organizations.service.ts'), 'utf8');
  const dtoSrc = readFileSync(join(__dirname, 'dto', 'create-organization.dto.ts'), 'utf8');

  it('the controller exposes no PATCH :id/dashboard-mode', () => {
    expect(controllerSrc).not.toMatch(/dashboard-mode/);
    expect(controllerSrc).not.toMatch(/setDashboardMode/);
  });

  it('the service has no setDashboardMode method', () => {
    expect(serviceSrc).not.toMatch(/setDashboardMode/);
  });

  it('the DTO layer exports no SetDashboardModeDto', () => {
    expect(dtoSrc).not.toMatch(/SetDashboardModeDto/);
  });
});
