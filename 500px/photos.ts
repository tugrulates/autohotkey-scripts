/** Prints the list of photos for a user.
 *
 * Usage:
 *   Usage: 500px/photos.ts <username> [--json]
 *
 * Output:
 *   🏞️ Coordinating Phoenix  📈91.1 👁️1085 ❤️95
 *   🏞️ Architectural Lasagna 📈91.9 👁️1176 ❤️142
 *
 * CSV:
 *   500px/photos.ts <username> --json | jq -f 500px/photos.csv.jq
 */

import { parseArgs } from "jsr:@std/cli";
import { getRequired } from "../common/cli.ts";
import { printTable, Row } from "../common/display.ts";
import { FiveHundredPxClient } from "./client.ts";
import { Photo } from "./types.ts";

/** Returns the display row of the photo. */
function getRow(photo: Photo): Row {
  return [
    `🏞️  ${photo.name}`,
    `📈${photo.pulse.highest}`,
    `❤️ ${photo.likedByUsers.totalCount}`,
    `👁️ ${photo.timesViewed}`,
  ];
}

if (import.meta.main) {
  const spec = { _: ["username"], boolean: ["json"] } as const;
  const args = parseArgs(Deno.args, spec);
  const [username] = getRequired(args, spec);

  const client = new FiveHundredPxClient();
  const photos = await client.getPhotos(username);

  if (args.json) console.log(JSON.stringify(photos, undefined, 2));
  else printTable(photos.map(getRow));
}
