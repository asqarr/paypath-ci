import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApplication, InMemoryDemoRepository } from "@paypath/demo-engine";
import { SupabaseDatabaseError } from "@paypath/supabase-adapter";
import { GET } from "./route.ts";
import { getDemoServices } from "../../../lib/services.ts";

vi.mock("../../../lib/services.ts", () => ({ getDemoServices: vi.fn() }));

const userId = "paypath-test-api-user";

describe("Entitlement API evidence responses", () => {
  let repository: InMemoryDemoRepository;

  beforeEach(() => {
    repository = new InMemoryDemoRepository();
    const application = new DemoApplication(repository, { mode: "fixed", scenario: null });
    vi.mocked(getDemoServices).mockReturnValue({ application, repository });
  });

  it("returns 200 with proAccess false when entitlement is absent", async () => {
    const response = await GET(new Request(`http://localhost/api/entitlement?userId=${userId}`));
    const body = await response.json() as { proAccess: boolean };

    expect(response.status).toBe(200);
    expect(body.proAccess).toBe(false);
  });

  it("preserves a backend read failure as 503 instead of treating it as absence", async () => {
    vi.spyOn(repository, "getEntitlement").mockRejectedValue(new SupabaseDatabaseError({
      operation: "entitlement read",
      errorType: "PostgrestError",
      errorCode: "42501",
      httpStatus: 403,
      message: "sensitive backend detail",
    }));
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new Request(`http://localhost/api/entitlement?userId=${userId}`));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain("sensitive backend detail");
    expect(String(logger.mock.calls[0]?.[1] ?? "")).toContain('"stage":"authorization_read"');
  });
});
