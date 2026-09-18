/**
 * Live vs simulated.
 *
 * The one thing this product must never do is present a simulated number as a
 * real one. A mock ad network crediting the ledger, or a stub model returning
 * usage, proves the plumbing works — it proves nothing about money. So the mode
 * is an explicit, inspectable property of the running server rather than
 * something you have to remember about how you launched it.
 *
 * The rule is: a mock endpoint anywhere in the path makes the whole economy
 * SIMULATED, and every surface that renders a figure says so. That is why this
 * is derived from the environment rather than passed in by a caller — a caller
 * that could declare itself live is a caller that could mislabel a mock.
 */

interface MockEndpoint {
  /** Environment variable that, when set, indicates a mock for this subsystem. */
  env: string;
  subsystem: "inference" | "ads" | "payments";
  /** What the mock replaces, in the words a person would use. */
  label: string;
}

const MOCK_ENDPOINTS: MockEndpoint[] = [
  { env: "INFYIELD_MOCK_LLM_URL", subsystem: "inference", label: "model inference" },
  { env: "INFYIELD_PROVIDER_BASE_URL", subsystem: "inference", label: "model inference" },
  { env: "INFYIELD_ETHICALADS_DECISION_URL", subsystem: "ads", label: "ad network" },
  { env: "INFYIELD_STRIPE_BASE_URL", subsystem: "payments", label: "payment provider" },
];

export type RuntimeMode = "live" | "test" | "simulated";

export interface ModeReport {
  mode: RuntimeMode;
  /** True whenever any subsystem is backed by a mock. */
  simulated: boolean;
  /** Which subsystems are mocked, and by which variable. */
  mocks: { subsystem: MockEndpoint["subsystem"]; env: string; label: string }[];
  /** Plain language, safe to render. */
  notice: string | null;
}

/**
 * `INFYIELD_MODE=test` forces test mode even with no mock wired up yet, which is
 * how a suite declares itself before it starts a mock. `live` is honoured only
 * when no mock endpoint is configured at all: asking to be called live while
 * pointed at a fake ad network is exactly the mislabelling this module exists to
 * prevent, so the mock wins and the report says so.
 */
export function modeReport(): ModeReport {
  const mocks = MOCK_ENDPOINTS.filter((m) => (process.env[m.env] ?? "").trim() !== "").map((m) => ({
    subsystem: m.subsystem,
    env: m.env,
    label: m.label,
  }));
  const declared = (process.env.INFYIELD_MODE ?? "").trim().toLowerCase();
  const simulated = mocks.length > 0;
  const mode: RuntimeMode = simulated ? "simulated" : declared === "test" ? "test" : "live";
  return {
    mode,
    simulated,
    mocks,
    notice: simulated
      ? `SIMULATED — ${mocks.map((m) => m.label).join(", ")} ${mocks.length > 1 ? "are" : "is"} backed by a local mock. Figures below prove the plumbing, not the money.`
      : mode === "test"
        ? "TEST MODE — the server is flagged for testing; figures are not production revenue."
        : null,
  };
}

/** Shorthand for surfaces that only need the badge. */
export function modeLabel(): string | null {
  const r = modeReport();
  if (r.simulated) return "SIMULATED";
  if (r.mode === "test") return "TEST";
  return null;
}
