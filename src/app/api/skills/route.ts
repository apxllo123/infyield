import { listSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** The skill catalog the composer offers. */
export async function GET() {
  return Response.json({
    skills: listSkills().map(({ id, name, blurb, tools, builtin }) => ({
      id,
      name,
      blurb,
      builtin: !!builtin,
      /** Empty means the full tool set; otherwise this is an allowlist. */
      tools,
      readOnly: tools.length > 0 && !tools.includes("write_file") && !tools.includes("edit_file"),
    })),
  });
}
