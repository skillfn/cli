export async function pullCommand(skid: string): Promise<void> {
  console.log(
    `\n'skillfn pull ${skid}' is not implemented yet.\n\n` +
      `Pulling a published skill requires a live hub API, which requires the Supabase project ` +
      `to be provisioned first.\n`,
  );
  process.exitCode = 1;
}
