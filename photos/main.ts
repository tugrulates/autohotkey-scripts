import { Command } from "@cliffy/command";
import { omit } from "@std/collections/omit";
import { expandGlob } from "@std/fs";
import { basename, join } from "@std/path";
import { displayVersion } from "@tugrulates/internal/package";
import { OPTIONAL_FIELDS, VARIANT_FIELDS } from "./fields.ts";
import { copyExifToVariants, getPhoto } from "./photo.ts";
import type { Photo } from "./types.ts";

const SOURCE_FILE = "source.jpg";

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile;
  } catch {
    return false;
  }
}

async function* getPhotos(photos: string[]): AsyncGenerator<Photo> {
  if (photos.length === 0) {
    for await (const entry of expandGlob(join("*", SOURCE_FILE))) {
      yield await getPhoto(entry.path);
    }
  }
  for (const photo of photos) {
    if (await isFile(photo)) {
      yield (await getPhoto(photo));
    } else if (await isFile(join(photo, SOURCE_FILE))) {
      yield getPhoto(join(photo, SOURCE_FILE));
    }
  }
}

function getWarnings(data: Photo): string[] {
  const result = [];
  for (const [field, value] of Object.entries(omit(data, OPTIONAL_FIELDS))) {
    if (!value) result.push(`missing:${field}`);
  }
  for (const size of data.variants) {
    for (const field in omit(size, VARIANT_FIELDS)) {
      if (field in data) result.push(`${basename(size.src)}:${field}`);
    }
  }
  return result;
}

async function getCommand() {
  return new Command()
    .name("photos")
    .description("Manage photos.")
    .version(await displayVersion())
    .example("photos", "Lists all photos under current directory.")
    .example("photos [photo] --json", "Data for a photo with all variants.")
    .example("photos [photo] --copy", "Copy EXIF data to all variants.")
    .arguments("[photos...:file]")
    .option("--copy", "Copy the EXIF from source JPG to other variants.")
    .option("--json", "Output the EXIF information as JSON.")
    .action(async ({ copy, json }, ...photos) => {
      for await (let photo of getPhotos(photos)) {
        if (copy) {
          await copyExifToVariants(photo);
          photo = await getPhoto(photo.src);
        }
        if (json) console.log(JSON.stringify(photo));
        else {
          const warnings = getWarnings(photo);
          if (warnings.length > 0) {
            console.log(
              `🖼  ${photo.title} [%c${warnings.join(" ")}%c]`,
              "color: yellow",
              "color: reset",
            );
          } else {
            console.log(`🖼  ${photo.title}`);
          }
        }
      }
    });
}

/** CLI entrypoint. */
export async function main(args: string[]) {
  const command = await getCommand();
  await command.parse(args);
}
