import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApplication, InMemoryDemoRepository, type DemoRepository } from "@paypath/demo-engine";
import { SupabaseDatabaseError } from "@paypath/supabase-adapter";
import { GET } from "./route.ts";
import { getDemoServices } from "../../../../lib/services.ts";

vi.mock("../../../../lib/services.ts", () => ({ getDemoServices: vi.fn() }));

const userId = "paypath-test-api-user";

describe("Pro feature API authorization", () => {
  let repository: InMemoryDemoRepository;

  beforeEach(() => {
    repository = new InMemoryDemoRepository();
    const application = new DemoApplication(repository, { mode: "fixed", scenario: null });
    vi.mocked(getDemoServices).mockReturnValue({ application, repository });
  });

  it("denies access when entitlement is absent", async () => {
    const response = await GET(new Request(`http://localhost/api/pro/feature?userId=${userId}`));
    const body = await response.json() as { proAccess: boolean };

    expect(response.status).toBe(403);
    expect(body.proAccess).toBe(false);
  });

  it("allows access when entitlement is active", async () => {
    await repository.seedEntitlement(userId, true);
    const response = await GET(new Request(`http://localhost/api/pro/feature?userId=${userId}`));
    const body = await response.json() as { proAccess: boolean };

    expect(response.status).toBe(200);
    expect(body.proAccess).toBe(true);
  });

  it("returns a fail-closed error and safe diagnostics on backend failure", async () => {
    const backendError = new SupabaseDatabaseError({
      operation: "entitlement read",
      errorType: "PostgrestError",
      errorCode: "42501",
      httpStatus: 403,
      message: "sensitive backend detail must not reach logs or response",
    });
    vi.spyOn(repository, "getEntitlement").mockRejectedValue(backendError);
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new Request(`http://localhost/api/pro/feature?userId=${userId}`));
    const responseText = await response.text();
    const logText = String(logger.mock.calls[0]?.[1] ?? "");

    expect(response.status).toBe(503);
    expect(responseText).not.toContain("sensitive backend detail");
    expect(logText).toContain('"endpoint":"/api/pro/feature"');
    expect(logText).toContain('"stage":"authorization_read"');
    expect(logText).toContain('"errorCode":"42501"');
    expect(logText).not.toContain("sensitive backend detail");
  });
});
