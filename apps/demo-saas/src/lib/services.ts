import { DemoApplication, InMemoryDemoRepository, parseDemoFaults } from "@paypath/demo-engine";
import { getSupabaseClientFromEnvironment, SupabaseDemoRepository } from "@paypath/supabase-adapter";

interface DemoServices {
  application: DemoApplication;
  repository: InMemoryDemoRepository | SupabaseDemoRepository;
}

const globalForPayPath = globalThis as typeof globalThis & { paypathDemoServices?: DemoServices };

export function getDemoServices(): DemoServices {
  if (globalForPayPath.paypathDemoServices !== undefined) return globalForPayPath.paypathDemoServices;

  const hasAnySupabaseSetting = Boolean(process.env["SUPABASE_URL"] || process.env["SUPABASE_SERVICE_ROLE_KEY"]);
  const repository = hasAnySupabaseSetting
    ? new SupabaseDemoRepository(getSupabaseClientFromEnvironment().client)
    : new InMemoryDemoRepository();
  const services: DemoServices = {
    application: new DemoApplication(repository, parseDemoFaults(process.env)),
    repository,
  };
  globalForPayPath.paypathDemoServices = services;
  return services;
}
