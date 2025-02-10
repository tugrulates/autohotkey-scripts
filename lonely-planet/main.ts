import { Command } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { displayVersion } from "@tugrulates/internal/package";
import { LonelyPlanetClient } from "./client.ts";
import { EMOJIS } from "./data.ts";
import type { Attraction, Destination } from "./types.ts";

/** Breadcrumb text from a location. */
function breadcrumb(document: Destination | Attraction) {
  return `[ ${
    document.breadcrumb.map((breadcrumb) => breadcrumb.title).join(" > ")
  } ]`;
}

async function getCommand() {
  return new Command()
    .name("lonely-planet")
    .description("Explores data from Lonely Planet.")
    .version(await displayVersion())
    .example("lonely-planet big sur", "Search destinations for 'big sur'.")
    .example("lonely-planet --attractions amsterdam", "Search attractions.")
    .example("lonely-planet --stories amsterdam", "Search stories.")
    .example("lonely-planet --destinations --attractions --stories", "All.")
    .example("lonely-planet --json | jq", "Stream destinations as json.")
    .arguments("[keywords...:string]")
    .option("--destinations", "Include destinations in the results.")
    .option("--attractions", "Include attractions in the results.")
    .option("--stories", "Include stories in the results.")
    .option("--json", "Output the search results as concatenated JSON.")
    .action(
      async ({ destinations, attractions, stories, json }, ...keywords) => {
        if (!destinations && !attractions && !stories) destinations = true;
        const client = new LonelyPlanetClient();
        const rows: string[][] = [];
        if (destinations) {
          for await (const doc of client.searchDestinations(keywords)) {
            if (json) console.log(JSON.stringify(doc));
            else rows.push([EMOJIS[doc.type], doc.title, breadcrumb(doc)]);
          }
        }
        if (attractions) {
          for await (const doc of client.searchAttractions(keywords)) {
            if (json) console.log(JSON.stringify(doc));
            else rows.push([EMOJIS[doc.type], doc.title, breadcrumb(doc)]);
          }
        }
        if (stories) {
          for await (const doc of client.searchStories(keywords)) {
            if (json) console.log(JSON.stringify(doc));
            else rows.push([EMOJIS[doc.type], doc.title]);
          }
        }
        Table.from(rows).render();
      },
    );
}

/** CLI entrypoint. */
export async function main(args: string[]) {
  const command = await getCommand();
  await command.parse(args);
}
