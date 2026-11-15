# Appearance and themes

Each theme is either light or dark, and the theme you pick decides which: there is no separate
light or dark setting, and Stellar does not follow your system's. Window chrome, menus and native
controls follow the theme too.

On web and desktop, open **Settings → Appearance** to choose a theme. Drive-In is the default.
Stellar, Night Edit, Darkroom, and Studio are the other dark themes; Long Biên, Sakura, Shore, and
Train Street are light. Appearance preferences are saved separately on each device or browser.

## Backdrop

Each built-in theme has its own scene behind new threads, empty screens and the pairing page,
drawn in that theme's colors: a drive-in for Drive-In, a planet's edge for Stellar, a city for
Night Edit, dunes for Darkroom and a soundstage for Studio. The light themes print theirs in dark
inks on pale paper: Hanoi's Long Biên bridge mirrored in the river at dawn, cherry boughs for
Sakura, surf on a beach for Shore, and a railway past shophouse doors for Train Street. A custom or
imported theme gets a ringed planet in its own colors. Behind a conversation the scene fades back so text stays easy to
read.

**Settings → Appearance → Backdrop** chooses how the scene is printed: dithered dots, halftone
dots, halftone CMYK, fluted glass, paper texture, or none. Each treatment has its own sliders, and
**Strength** fades the scene everywhere. The scene shifts slightly with the pointer on a new
thread, except when your system asks for reduced motion.

With dithered dots or fluted glass, the scene also moves gently: stars twinkle, city windows go
on and off, a train crosses now and then, petals fall and surf runs up the beach. It rests while
the timeline monitor plays, while an agent is replying, when the window is in the background, and
when your system asks for reduced motion. Turn **Animate background** off to keep it still.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Customize the shortcut under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Stellar or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

A theme with a light canvas is a light theme, whether you made it or imported it. A Stellar theme
file saved with both a light and a dark palette keeps its dark one.

## Project themes

A project can carry its own theme, so moving between projects changes the look: a Hanoi short in
Long Biên, a brand video in its brand colors. Pick it in **Settings → Projects → Theme**, or ask an
agent to set it. Its threads, new-thread screen, video workspace and project settings show that
theme; everywhere else shows yours. **Use my theme** clears it. Choosing a theme while in the
project saves it as your own, which comes back when you leave.

Every device that opens the project sees its theme. A custom theme that exists only on another
device, or a theme that was deleted, shows your own instead. The mobile app shows built-in project
themes only.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. With the desktop app's local environment off, they come from the
[background service](./background-service.md) on the same machine while the app is connected to
it. Other connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, Stellar falls back to
Drive-In.

Run this on the server to set a default and switch connected clients to it:

```bash
stellar theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `stellar theme set`. Run the command again to
reapply it, even if the name is unchanged.

`stellar theme clear` removes the default without changing anyone's current theme. `stellar theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from Stellar into `~/.stellar/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `stellar theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Supply hex colors for a `canvas` and an `accent`; a light canvas makes a light theme. Stellar
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view. A file marked `"appearance": "light"` that also has a `variants.dark` palette publishes that
dark palette.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
