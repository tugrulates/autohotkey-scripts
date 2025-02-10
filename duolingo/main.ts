import { Command } from "@cliffy/command";
import { Input, Secret } from "@cliffy/prompt";
import { Table } from "@cliffy/table";
import { pool } from "@tugrulates/internal/async";
import { Config } from "@tugrulates/internal/config";
import { displayVersion } from "@tugrulates/internal/package";
import { DuolingoClient } from "./client.ts";
import { LEAGUES } from "./data.ts";
import {
  engageWithCard,
  followLeagueUsers,
  getEmoji,
  getLeagueUserEmoji,
} from "./interaction.ts";
import type { FeedCard, League } from "./types.ts";

type DuolingoConfig = { username: string; token: string };

/** Duolingo client built from common CLI options. */
async function getClient(
  config: Config<DuolingoConfig>,
): Promise<DuolingoClient> {
  let { username, token } = await config.get();
  if (!username) username = await Input.prompt("Username");
  if (!token) token = await Secret.prompt("Token");
  if (!username || !token) throw new Error("Username and token are required.");
  return new DuolingoClient(username, token);
}

/**
 * Fetches and organizes follow information.
 *
 * @returns Users who are followed, users who follow, and their difference sets.
 */
async function getFollows(client: DuolingoClient) {
  const [following, followers] = await Promise.all([
    client.getFollowing(),
    client.getFollowers(),
  ]);
  return {
    following,
    followers,
    dontFollowBack: following.filter(({ userId }) =>
      !followers.some((user) => user.userId === userId)
    ),
    notFollowingBack: followers.filter(({ userId }) =>
      !following.some((user) => user.userId === userId)
    ),
  };
}

/**
 * Outputs the league to the console.
 *
 * @param league League to output.
 */
async function outputLeague(client: DuolingoClient, league: League) {
  const following = await client.getFollowing();
  const tier = LEAGUES[league.tier];
  new Table()
    .header([tier.emoji, tier.name])
    .body(
      league.rankings.map((user, index) => [
        `${index + 1}.`,
        `${user.display_name} ${getLeagueUserEmoji(user)}`,
        following.find((f) => f.userId === user.user_id) ? "👤" : "",
        `${user.score.toString()} XP`,
      ]),
    )
    .columns([{ align: "right" }, {}, {}, { align: "right" }])
    .render();
}

/**
 * Returns the display summary of the card.
 *
 * @param card Card to get the summary for.
 * @returns Display summary of the card.
 */
function getSummary(card: FeedCard): string {
  return card.header
    ? card.header
      .replace(/[\u200E-\u200F]/g, "")
      .replace(/<[^>]+>/g, "")
    : `${card.displayName} ${card.body.toLowerCase()}`;
}

function getFeedCommand(config: Config<DuolingoConfig>) {
  return new Command()
    .description("Prints and interacts with the feed.")
    .example("duolingo feed", "Prints the feed.")
    .example("duolingo feed --engage", "Engages with the feed.")
    .example("duolingo feed --json | jq", "Query JSON over the feed.")
    .option("--engage", "Engage with the feed events.")
    .option("--json", "Output the feed as JSON.")
    .action(async ({ engage, json }) => {
      const client = await getClient(config);
      const followers = await client.getFollowers();
      const cards = await client.getFeedCards();
      if (json) console.log(JSON.stringify(cards, undefined, 2));
      await pool(
        cards,
        async (card) => {
          if (!engage || await engageWithCard(client, followers, card)) {
            if (!json) console.log(`${getEmoji(card)} ${getSummary(card)}`);
          }
        },
      );
    });
}

function getFollowsCommand(config: Config<DuolingoConfig>) {
  return new Command()
    .description("Prints and manages follower information on Duolingo.")
    .example("duolingo follows", "Prints follow counts.")
    .example("duolingo follows --follows", "Follow users who follow.")
    .example("duolingo follows --unfollow", "Unfollow users who dont' follow.")
    .example("duolingo follows --follow --unfollow", "Matches both lists.")
    .example("duolingo follows --json", "Outputs JSON of follower information.")
    .example(
      "duolingo follows --json | jq",
      "Query JSON for follower information.",
    )
    .example(
      "duolingo follows --json | jq '.dontFollowBack[].username'",
      "List users who are followed but don't follow back.",
    )
    .example(
      "duolingo follows --json | jq '.notFollowingBack[].username'",
      "List users who follow but are not followed back.",
    )
    .option("--follow", "Follow users who follow.")
    .option("--unfollow", "Unfollow users who don't follow.")
    .option("--json", "Output the follower information as JSON.")
    .action(async ({ follow, unfollow, json }) => {
      const client = await getClient(config);
      let result = await getFollows(client);

      if (follow || unfollow) {
        if (follow) {
          await pool(
            result.notFollowingBack,
            async (user) => {
              if (user.canFollow) {
                await client.followUser(user.userId);
                if (!json) console.log(`✅ Followed ${user.username}.`);
              }
            },
          );
        }
        if (unfollow) {
          await pool(
            result.dontFollowBack,
            async (user) => {
              await client.unfollowUser(user.userId);
              if (!json) console.log(`❌ Unfollowed ${user.username}.`);
            },
          );
        }
        result = await getFollows(client);
      }

      if (json) console.log(JSON.stringify(result, undefined, 2));
      else {
        console.log(`👤 Following ${result.following.length} people.`);
        console.log(`👤 Followed by ${result.followers.length} people.`);
      }
    });
}

function getLeagueCommand(config: Config<DuolingoConfig>) {
  return new Command()
    .description("Prints and interacts with the current Duolingo league.")
    .example("duolingo league", "Prints the league.")
    .example("duolingo league --follow", "Follows users in the league.")
    .example("duolingo league --json | jq", "Query JSON over the league.")
    .option("--follow", "Follow users in the league.")
    .option("--json", "Output the league as JSON.")
    .action(async ({ follow, json }) => {
      const client = await getClient(config);
      const league = await client.getLeague();
      if (league) {
        if (follow) await followLeagueUsers(client, league.rankings);
        if (json) console.log(JSON.stringify(league, undefined, 2));
        else await outputLeague(client, league);
      } else {
        if (json) console.log("{}");
        else console.log("🏆 The league has not started yet.");
      }
    });
}

async function getCommand(config: Config<DuolingoConfig>) {
  const { username, token } = await config.get();
  const command = new Command()
    .name("duolingo")
    .description("Interact with Duolingo.")
    .usage("--username <username> --token <token> <command> [options]")
    .version(await displayVersion())
    .example("duolingo --username <username> --token <token>", "Configure.")
    .example("duolingo --clear", "Clear the cached configuration.")
    .option("--clear", "Clear the cached configuration.", {
      standalone: true,
      action: () => config.clear(),
    })
    .globalEnv(
      "DUOLINGO_USERNAME=<username:string>",
      "Username.",
      { prefix: "DUOLINGO_" },
    )
    .globalOption(
      "--username <username:string>",
      "Username.",
      username ? { default: username } : {},
    )
    .globalEnv(
      "DUOLINGO_TOKEN=<token:string>",
      "JWT token.",
      { prefix: "DUOLINGO_" },
    )
    .globalOption(
      "--token <token:string>",
      "JWT token.",
      token ? { default: token } : {},
    )
    .help({ colors: Deno.stdout.isTerminal() })
    .noExit()
    .globalAction((options) => config.set(options))
    .command("feed", getFeedCommand(config))
    .command("follows", getFollowsCommand(config))
    .command("league", getLeagueCommand(config));
  return command;
}

/** CLI entrypoint. */
export async function main(args: string[], options?: { path?: string }) {
  using config = new Config<DuolingoConfig>(options);
  const command = await getCommand(config);
  await command.parse(args);
}
