/**
 * Directory names that are never a skill's own content, wherever they appear in a skill's
 * tree -- VCS internals and installed dependency trees, never a skill's own authored code or
 * data. A skill's security posture is about what it actually ships and does, not about git's
 * own stock sample hooks or someone else's node_modules getting swept in because they
 * happened to sit inside the folder.
 *
 * Deliberately narrow: build/dist/.next/target etc. are NOT here even though they're common
 * noise, because build output can be exactly where a compromised dependency or supply-chain
 * attack hides an injected bundle -- excluding it would trade a real coverage gap for
 * convenience, a different kind of mistake than stripping git's own inert boilerplate.
 *
 * Shared between skillTreeDiscovery.ts (deciding where skills/orphans are) and
 * skillSpectorScanner.ts (deciding what actually gets handed to the scanner) -- both need
 * the identical judgment call, and they used to disagree: discovery already skipped these,
 * the scanner didn't, which is exactly how a vendored .git full of git's own sample hooks
 * ended up reported as "14 HIGH: executable nested in a document" on an unrelated skill.
 */
export const EXCLUDED_DIR_NAMES = new Set([".git", ".svn", ".hg", "node_modules", ".venv", "venv", "__pycache__"]);
