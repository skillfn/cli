export async function pullCommand(skid: string): Promise<void> {
  console.log(
    `\n'skillfn pull ${skid}' is not implemented yet.\n\n` +
      `Pulling a published skill requires a live hub API, which requires the Supabase project ` +
      `to be provisioned first — see extra/plans/07-roadmap.md, Phase 0.\n`,
  );
  process.exitCode = 1;
}
