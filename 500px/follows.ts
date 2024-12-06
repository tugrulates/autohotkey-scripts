/** Prints follow information.
 *
 * Usage:
 *   500px/follows.ts --username <username> --token <token> [--json]
 *
 * Output:
 *   👤 Following 212 people.
 *   👤 Followed by 89 people.
 *
 * JSON:
 *   {
 *     "following": [ { "id": "id1", "displayName": "example1" } ],
 *     "followers": [ { "id": "id2", "displayName": "example2" } ],
 *     "dontFollowBack": [],
 *     "notFollowingBack": []
 *   }
 */

import { parseArgs } from "jsr:@std/cli";
import { FiveHundredPxClient } from "./client.ts";

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["username"],
    boolean: ["json"],
  });
  if (!args.username) {
    console.error(`Usage: follows.ts --username <username> [--json]`);
    Deno.exit(1);
  }

  const client = new FiveHundredPxClient();
  const [following, followers] = await Promise.all([
    client.getFollowing(args.username),
    client.getFollowers(args.username),
  ]);
  const result = {
    following,
    followers,
    dontFollowBack: following.filter(({ id }) =>
      !followers.some((user) => user.id === id)
    ),
    notFollowingBack: followers.filter(({ id }) =>
      !following.some((user) => user.id === id)
    ),
  };

  if (args.json) console.log(JSON.stringify(result, undefined, 2));
  else {
    console.log(`👤 Following ${result.following.length} people.`);
    console.log(`👤 Followed by ${result.followers.length} people.`);
  }
}
