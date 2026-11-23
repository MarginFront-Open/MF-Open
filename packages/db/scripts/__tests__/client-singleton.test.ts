import { afterEach, describe, expect, it, vi } from "vitest";

const constructorSpy = vi.fn();

vi.mock("@prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    constructor(options?: unknown) {
      constructorSpy(options);
    }
  },
}));

describe("Prisma client singleton", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    delete (globalThis as { prisma?: unknown }).prisma;
    constructorSpy.mockClear();
  });

  it("reuses one PrismaClient via globalThis across module reloads in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete (globalThis as { prisma?: unknown }).prisma;

    vi.resetModules();
    const first = await import("../../src/client");

    vi.resetModules();
    const second = await import("../../src/client");

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(second.db).toBe(first.db);
    expect((globalThis as { prisma?: unknown }).prisma).toBe(first.db);
  });
});
