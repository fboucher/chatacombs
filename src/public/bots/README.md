# Bot images

Pictures of the Chatacombs bot for the overlay: CloudBot's CeeBee in costume. Pick one with `?bot=<name>` on the overlay URL.

| File | `bot=` | Look |
| --- | --- | --- |
| `chatacombs-bot-skeleton.png` | `skeleton` (default) | CeeBee disguised as a skeleton |
| `chatacombs-bot-mummy.png` | `mummy` | CeeBee disguised as a mummy |
| `chatacombs-bot-cyberpunk.png` | `cyberpunk` | CeeBee with a neon mohawk and shades |
| `chatacombs-bot-pirate.png` | `pirate` | CeeBee with a tricorn hat, eyepatch and hook |
| `chatacombs-bot-retro.png` | `retro` | CeeBee as an 80s home computer |

The `.svg` files are the editable sources the PNGs were rendered from (transparent background, cropped with 8px of padding).

## Adding your own

Drop a file named `chatacombs-bot-<name>.png` here (lowercase letters, digits, `-` or `_`), then use `?bot=<name>`. `.webp`, `.gif`, `.jpg` and `.svg` also work; when a name has several files, the `.png` wins. Use a transparent background about 530px wide: the overlay shows it at most 150x100. With Docker, rebuild the image (`docker compose up -d --build`) so it includes the new file.
