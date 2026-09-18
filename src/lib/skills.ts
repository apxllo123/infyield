import type { Skill } from "./types";

/**
 * Skills: named ways of working.
 *
 * A skill is not a prompt template — it changes what the agent is allowed to do
 * (its tool set) and how it is told to work (its instructions). A read-only skill
 * genuinely cannot write or run anything, because the tool list it is served is
 * filtered before the request leaves the process and the executor refuses calls
 * outside that list. That makes "Explain" and "Review" safe to hand a whole
 * repository, rather than safe only by convention.
 *
 * Built-ins are deliberately generic: they work on any project (Node, Python,
 * Rust, Go) because they describe the workflow, not a specific toolchain.
 */

const READ_ONLY = ["read_file", "list_dir", "search"];
const READ_RUN = ["read_file", "list_dir", "search", "run_command"];

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "build",
    name: "Build a feature",
    blurb: "Read first, change the fewest files, verify by running things.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: build the feature end to end.",
      "1. Read the files you are about to change before touching them, and search for existing helpers you should use instead of writing new ones.",
      "2. Make the smallest coherent change that delivers the feature; match the project's existing conventions and naming.",
      "3. Then prove it: run the project's type check, build, or test command with run_command and fix what it reports before you finish.",
      "Never leave a half-wired change behind, and never describe work you have not actually run.",
    ].join("\n"),
  },
  {
    id: "debug",
    name: "Debug a failure",
    blurb: "Reproduce it, find the real cause, fix it, prove it is fixed.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: diagnose before you edit.",
      "1. Reproduce the failure first — run the command, test or repro step with run_command and read the actual error rather than reasoning from the summary.",
      "2. Locate the cause in the source (search, then read the surrounding code). State the cause in one sentence before changing anything.",
      "3. Fix the cause, not the symptom. Avoid defensive try/catch or silent fallbacks that would hide the failure instead.",
      "4. Re-run the repro to confirm the failure is gone, and say which command proves it.",
    ].join("\n"),
  },
  {
    id: "tests",
    name: "Test and fix",
    blurb: "Run the suite, then fix the real failures it reports.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: make the suite green, honestly.",
      "1. Start with the run_tests tool (or the project's own test command) and read the real output before predicting anything.",
      "2. Fix the production code the test is exercising. Do not weaken an assertion, skip a test, or delete coverage to make a failure disappear.",
      "3. When a test is genuinely wrong, say so explicitly and explain what the correct behaviour is.",
      "Finish by re-running the suite and quoting the result.",
    ].join("\n"),
  },
  {
    id: "review",
    name: "Code review",
    blurb: "Read-only. Find real defects, with file and line evidence.",
    builtin: true,
    tools: READ_ONLY,
    instructions: [
      "Workflow: review, do not modify. You have no write or run tools — if the request requires editing, say so and hand it back.",
      "Report only defects you can point at, each as: file:line, what breaks, and the concrete input or condition that triggers it.",
      "Rank by severity. Prefer correctness and security over style. Say plainly when you found nothing wrong rather than padding the list.",
    ].join("\n"),
  },
  {
    id: "explain",
    name: "Explain the code",
    blurb: "Read-only walkthrough of how something actually works.",
    builtin: true,
    tools: READ_ONLY,
    instructions: [
      "Workflow: explain. You have no write or run tools.",
      "Trace the real call path through the source and describe the flow in the order it executes, naming the files involved.",
      "Call out the parts that are surprising, load-bearing, or easy to break. Do not invent behaviour you have not read.",
    ].join("\n"),
  },
  {
    id: "refactor",
    name: "Refactor",
    blurb: "Behaviour-preserving cleanup, verified against the tests.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: restructure without changing behaviour.",
      "1. Capture the current behaviour first — run the tests or the relevant command so you have a baseline.",
      "2. Make the change in small steps, keeping public interfaces intact unless the task explicitly changes them.",
      "3. Re-run the same verification afterwards; any difference in behaviour means the refactor is wrong. Report the before/after result.",
    ].join("\n"),
  },
  {
    id: "ship",
    name: "Ship it",
    blurb: "Implement, verify, then commit with a message worth reading.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: take the change all the way to a commit.",
      "Implement it, verify it (type check / build / test), then inspect `git status` and `git diff` and stage only the files this task touched.",
      "Commit with a concise message explaining why the change exists, not what the diff shows, and include the staged-file list in your summary.",
      "Do not push.",
    ].join("\n"),
  },
  {
    id: "perf",
    name: "Performance",
    blurb: "Measure before and after; optimise the real bottleneck.",
    builtin: true,
    tools: [],
    instructions: [
      "Workflow: measure, then optimise.",
      "1. Establish a measurement first — time the command, benchmark the function, count the queries. A number you did not measure is a guess.",
      "2. Optimise the bottleneck the measurement identified, not the one that looks expensive.",
      "3. Re-measure with the same method and report both numbers. If the change did not help, say so and revert it.",
    ].join("\n"),
  },
];

/** Every skill the app offers, built-ins first. */
export function listSkills(): Skill[] {
  return BUILTIN_SKILLS;
}

export function getSkill(id: string): Skill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}

/**
 * Resolve a selection into skills. Unknown ids are ignored rather than fatal, so
 * a stale client (or a removed skill) degrades to the default behaviour.
 */
export function resolveSkills(ids: string[] | undefined): Skill[] {
  if (!ids?.length) return [];
  const out: Skill[] = [];
  for (const id of ids) {
    const s = getSkill(id);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The union of tools the selected skills permit. No skills means the full tool
 * set; any skill with an empty allowlist (`tools: []`) means "everything",
 * because building and testing legitimately needs every tool there is.
 */
export function allowedToolNames(skills: Skill[]): Set<string> | null {
  if (!skills.length) return null;
  const allow = new Set<string>();
  let unrestricted = false;
  for (const s of skills) {
    if (!s.tools.length) unrestricted = true;
    for (const t of s.tools) allow.add(t);
  }
  return unrestricted ? null : allow;
}
