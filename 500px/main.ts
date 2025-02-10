import { Command, EnumType } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { displayVersion } from "@tugrulates/internal/package";
import { FiveHundredPxClient } from "./client.ts";
import { CATEGORIES } from "./data.ts";
import type { Photo } from "./types.ts";

/**
 * Skip list for user IDs.
 *
 * Skips photos copied from VCG.
 */
const SKIP = [/^\/vcg-/];

/**
 * Outputs the photos to the console.
 *
 * @param photos Photos to output.
 */
function output(photos: Photo[]) {
  new Table()
    .body(photos.map((photo) => [
      `🏞️ ${photo.name}`,
      `📈${photo.pulse.highest}`,
      `❤️ ${photo.likedByUsers.totalCount}`,
      `👁️ ${photo.timesViewed}`,
    ]))
    .render();
}

function getDiscoverCommand() {
  return new Command()
    .description("Prints a list of active and high quality users on 500px.")
    .example(
      "500px discover",
      "Prints a list of users with high scored photos.",
    )
    .example("500px discover --filter food", "Finds food photographers.")
    .example(
      "500px discover --filter macro --filter animals",
      "Either category.",
    )
    .example("500px discover --json | jq", "Query users as JSON.")
    .type("category", new EnumType(Object.values(CATEGORIES).map((c) => c.opt)))
    .option(
      "--category <category:category>",
      "Categories to filter results on.",
      { collect: true },
    )
    .option("--json", "Output the list of users as JSON.")
    .action(async ({ category, json }) => {
      const categories = Object.values(CATEGORIES).filter((c) =>
        !category || category.includes(c.opt)
      );
      const client = new FiveHundredPxClient();
      const photos = await client.getForYouFeed({ categories, limit: 1000 });
      const users = photos.map((photo) => photo.photographer.canonicalPath)
        .filter((user) => !SKIP.some((re) => re.test(user)));
      const result = { discover: Array.from(new Set(users)) };
      if (json) console.log(JSON.stringify(result, undefined, 2));
      else result.discover.forEach((user) => console.log(`👤 ${user}`));
    });
}

function getFollowsCommand() {
  return new Command()
    .description("Prints follower information on 500px.")
    .example("500px follows", "Prints follow counts.")
    .example("500px follows --follows", "Follow users who follow.")
    .example("500px follows --unfollow", "Unfollow users who dont' follow.")
    .example("500px follows --follow --unfollow", "Matches both lists.")
    .example("500px follows --json", "Outputs JSON of follower information.")
    .example(
      "500px follows --json | jq",
      "Query JSON for follower information.",
    )
    .example(
      "500px follows --json | jq '.dontFollowBack[].username'",
      "List users who are followed but don't follow back.",
    )
    .example(
      "500px follows --json | jq '.notFollowingBack[].username'",
      "List users who follow but are not followed back.",
    )
    .arguments("<username:string>")
    .option("--json", "Output the follower information as JSON.")
    .action(async ({ json }, username) => {
      const client = new FiveHundredPxClient();
      const [following, followers] = await Promise.all([
        client.getFollowing(username),
        client.getFollowers(username),
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

      if (json) console.log(JSON.stringify(result, undefined, 2));
      else {
        console.log(`👤 Following ${result.following.length} people.`);
        console.log(`👤 Followed by ${result.followers.length} people.`);
      }
    });
}

function getPhotosCommand() {
  return new Command()
    .description("Prints the list of photos for a 500px user.")
    .example("500px photos <username>", "Prints the list of photos for a user.")
    .example("500px photos <username> --json | jq", "Query photos as JSON.")
    .arguments("<username:string>")
    .option("--json", "Output the photo information as JSON.")
    .action(async ({ json }, username) => {
      const client = new FiveHundredPxClient();
      const photos = await client.getPhotos(username);

      if (json) console.log(JSON.stringify(photos, undefined, 2));
      else output(photos);
    });
}

async function getCommand() {
  const command = new Command()
    .name("500px")
    .description("Interact with 500px.")
    .usage("<command> [options]")
    .version(await displayVersion())
    .action((): void => command.showHelp())
    .command("discover", getDiscoverCommand())
    .command("follows", getFollowsCommand())
    .command("photos", getPhotosCommand());
  return command;
}

/** CLI entrypoint. */
export async function main(args: string[]) {
  const command = await getCommand();
  await command.parse(args);
}
