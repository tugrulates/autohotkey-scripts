/**
 * Prints the current Duolingo feed.
 *
 * Optionally and jovially engages with the events.
 *
 * ### Usage
 *
 * ```sh
 * deno -A duolingo/feed.ts <username> <token> [--engage] [--json]
 * ```
 *
 * ```
 * 🎉 John Doe Completed a 30 day streak!
 * 👤 Jane Doe started following you!
 * ```
 */

import { parseArgs } from "jsr:@std/cli";
import { pool } from "../common/async.ts";
import { getRequired } from "../common/cli.ts";
import { DuolingoClient } from "./client.ts";
import { REACTIONS } from "./data.ts";
import { FeedCard, Friend, Reaction } from "./types.ts";

/**
 * Returns the reaction on the card, or picks an appripriate one.
 *
 * @param card Card to get the reaction for.
 * @returns Reaction on the card.
 */
function getReaction(card: FeedCard): Reaction {
  if (card.reactionType) return card.reactionType;
  if (card.cardType === "SHARE_SENTENCE_OFFER") return "like";
  const number = card.body.match(/\d+/);
  if (number && Number(number[0]) % 100 === 0) return "cheer";
  if (
    card.triggerType === "top_three" || card.triggerType === "league_promotion"
  ) return "love";
  if (card.triggerType === "resurrection") return "high_five";
  if (card.triggerType === "monthly_goal") return "support";
  if (card.defaultReaction !== null) return card.defaultReaction;
  return "cheer";
}

/**
 * Returns the display emoji for the card.
 *
 * @param card Card to get the emoji for.
 * @returns Display emoji for the card.
 */
function getEmoji(card: FeedCard): string {
  if (card.cardType === "FOLLOW" || card.cardType === "FOLLOW_BACK") {
    return "👤";
  }
  return REACTIONS[getReaction(card)];
}

/**
 * Returns the display summary of the card.
 *
 * @param card Card to get the summary for.
 * @returns Display summary of the card.
 */
function getSummary(card: FeedCard): string {
  return card.header?.replace(/<[^>]+>/g, "") ??
    `${card.displayName} ${card.body.toLowerCase()}`;
}

/**
 * Engages with the event, following the user or sending a reaction.
 *
 * @param client Duolingo client.
 * @param followers List of followers, to skip in follow-backs.
 * @param card Card to engage with.
 * @returns True if the event was engaged with.
 */
async function engage(
  client: DuolingoClient,
  followers: Friend[],
  card: FeedCard,
): Promise<boolean> {
  if (card.cardType === "FOLLOW") {
    const user = followers.find((user) => user.userId === card.userId);
    if (!user?.isFollowing) {
      await client.followUser(card.userId);
      return true;
    }
  } else if (
    card.cardType === "KUDOS_OFFER" ||
    card.cardType === "SHARE_SENTENCE_OFFER"
  ) {
    if (!card.reactionType) {
      await client.sendReaction(card.eventId, getReaction(card));
      return true;
    }
  }
  return false;
}

if (import.meta.main) {
  const spec = {
    _: ["username", "token"],
    boolean: ["engage", "json"],
  } as const;
  const args = parseArgs(Deno.args, spec);
  const [username, token] = getRequired(args, spec);

  const client = new DuolingoClient(username, token);
  const followers = await client.getFollowers();
  const feed = await client.getFeed();
  if (args.json) console.log(JSON.stringify(feed, undefined, 2));
  await pool(
    feed,
    async (card) => {
      if (!args.engage || await engage(client, followers, card)) {
        if (!args.json) console.log(getEmoji(card), getSummary(card));
      }
    },
  );
}
